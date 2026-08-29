import "dotenv/config";
import express from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { sessionStore } from "./sessionStore.js";
import { runTurn } from "./agent.js";
import { transcribeAudio, generateSpeech } from "./groqServices.js";
import { preprocessAudio } from "./audioProcessing.js";
import { saveOrder, getAllOrders } from "./db.js";
import { recordUsage, getAllUsage } from "./usageDb.js";
import { AccessToken } from "livekit-server-sdk";
import { RoomAgentDispatch, RoomConfiguration } from "@livekit/protocol";

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Configure multer for in-memory audio file uploads
const upload = multer({ storage: multer.memoryStorage() });

if (!process.env.GROQ_API_KEY) {
  console.warn("[warn] GROQ_API_KEY is not set in environment variables.");
}

// Start or resume session
app.post("/api/session", (_req, res) => {
  const sessionId = nanoid(12);
  sessionStore.create(sessionId);
  res.json({ sessionId });
});

// Mints a LiveKit room-join token for the real-time (VAD/barge-in) call
// flow. Room name encodes the sessionId so the worker (livekitAgent.js) can
// recover the same session/cart the HTTP flow would have used. Explicit
// agent dispatch via roomConfig scopes which worker joins this room.
app.post("/api/livekit-token", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
  if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
    return res.status(500).json({ error: "LiveKit is not configured on the server" });
  }

  sessionStore.getOrCreate(sessionId);
  const roomName = `call-${sessionId}`;

  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: `caller-${sessionId}`,
  });
  token.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  token.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: process.env.LIVEKIT_AGENT_NAME || "voice-order-agent" })],
  });

  res.json({ token: await token.toJwt(), url: process.env.LIVEKIT_URL, roomName });
});

// Text Chat Endpoint
app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: "sessionId and message are required" });
  }
  const session = sessionStore.getOrCreate(sessionId);
  if (session.status !== "active") {
    return res.status(409).json({ error: `Session is ${session.status}` });
  }

  try {
    const result = await runTurn(session, message);
    res.json({ sessionId, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Agent turn failed", detail: err.message });
  }
});

/**
 * End-to-End Voice Endpoint:
 * Audio In (Groq Whisper STT) -> Agent Turn (Gemini) -> Audio Out (Groq TTS)
 */
app.post("/api/voice-chat", upload.single("audio"), async (req, res) => {
  const sessionId = req.body.sessionId;
  const audioFile = req.file;

  if (!sessionId || !audioFile) {
    return res.status(400).json({ error: "sessionId and audio file are required" });
  }

  const session = sessionStore.getOrCreate(sessionId);
  if (session.status !== "active") {
    return res.status(409).json({ error: `Session is ${session.status}` });
  }

  const pipelineStartedAt = Date.now();
  let stageReached = "stt";

  try {
    // Step 1a: backend audio normalization (highpass, loudness-normalize,
    // trim silence, downmix to 16kHz mono). Falls back to the raw upload
    // if ffmpeg chokes on a malformed clip, so one bad file can't 500 the call.
    let sttBuffer = audioFile.buffer;
    let sttMime = audioFile.mimetype;
    let audioSeconds = null;
    try {
      sttBuffer = await preprocessAudio(audioFile.buffer);
      sttMime = "audio/wav";
      // 16kHz mono 16-bit PCM WAV (44-byte header) -- see audioProcessing.js
      audioSeconds = Math.max(0, sttBuffer.length - 44) / 2 / 16000;
    } catch (preprocessErr) {
      console.warn("Audio preprocessing failed, using raw upload:", preprocessErr.message);
    }

    // Step 1b: STT via Groq Whisper
    const stt = await transcribeAudio(sttBuffer, sttMime);
    const userText = stt.text;

    // Step 2: Agent processing via Groq
    stageReached = "llm";
    const agentResult = await runTurn(session, userText);

    // Step 3: TTS via Groq Orpheus (falls back to Deepgram internally)
    stageReached = "tts";
    console.log(`Generating speech for text: "${agentResult.reply}"`);
    const tts = await generateSpeech(agentResult.reply);
    console.log(`Speech generated successfully. Buffer size: ${tts.buffer.length} bytes`);

    // Persist order to JSON DB if it was just placed this turn
    if (agentResult.cart?.placed) {
      const session = sessionStore.get(sessionId);
      if (session) saveOrder(session);
    }

    recordUsage({
      sessionId,
      durationMs: Date.now() - pipelineStartedAt,
      status: tts.usedFallback ? "fallback" : "success",
      stt: {
        provider: stt.provider,
        model: stt.model,
        latencyMs: stt.latencyMs,
        audioSeconds,
        status: "ok",
      },
      llm: {
        provider: "groq",
        model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
        latencyMs: agentResult.metrics.elapsedMs,
        inputTokens: agentResult.metrics.inputTokens,
        outputTokens: agentResult.metrics.outputTokens,
        rounds: agentResult.metrics.rounds,
        tokenBreakdown: agentResult.metrics.tokenBreakdown,
        toolCalls: agentResult.toolCalls.map((c) => ({ name: c.name, ok: c.ok })),
        status: "ok",
      },
      tts: {
        provider: tts.provider,
        model: tts.model,
        usedFallback: tts.usedFallback,
        fallbackReason: tts.fallbackReason || null,
        characters: tts.characters,
        latencyMs: tts.latencyMs,
        status: "ok",
      },
    });

    // Return agent JSON payload along with Base64 audio
    res.json({
      sessionId,
      userText,
      replyText: agentResult.reply,
      audioBase64: tts.buffer.toString("base64"),
      toolCalls: agentResult.toolCalls,
      cart: agentResult.cart,
      metrics: agentResult.metrics,
      sessionStatus: agentResult.sessionStatus,
    });
  } catch (err) {
    console.error("Voice pipeline error:", err);
    recordUsage({
      sessionId,
      durationMs: Date.now() - pipelineStartedAt,
      status: "failed",
      stt: { status: stageReached === "stt" ? "error" : "ok", error: stageReached === "stt" ? err.message : undefined },
      llm: { status: stageReached === "llm" ? "error" : "ok", error: stageReached === "llm" ? err.message : undefined },
      tts: { status: stageReached === "tts" ? "error" : "ok", error: stageReached === "tts" ? err.message : undefined },
      failedStage: stageReached,
    });
    res.status(500).json({ error: "Voice processing failed", detail: err.message });
  }
});

// Standalone TTS Endpoint
app.post("/api/tts", async (req, res) => {
  const { text, voice } = req.body;
  if (!text) return res.status(400).json({ error: "Text is required" });

  try {
    const tts = await generateSpeech(text, voice);
    res.setHeader("Content-Type", "audio/wav");
    res.send(tts.buffer);
  } catch (err) {
    res.status(500).json({ error: "TTS failed", detail: err.message });
  }
});

// Cart and Orders endpoints
app.get("/api/cart/:sessionId", (req, res) => {
  const session = sessionStore.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Unknown session" });
  res.json(session.cart.view());
});

// Welcome greeting endpoint — returns TTS audio for the opening message
app.post("/api/greet", async (_req, res) => {
  const greeting =
    "Welcome! Thank you for calling. I'm your voice ordering assistant. " +
    "Would you like to hear today's menu, or are you ready to place your order?";
  try {
    const tts = await generateSpeech(greeting);
    res.json({ audioBase64: tts.buffer.toString("base64"), text: greeting });
  } catch (err) {
    res.status(500).json({ error: "Greeting failed", detail: err.message });
  }
});

// Orders — merged from in-memory store + persisted DB
app.get("/api/orders", (_req, res) => {
  const orders = getAllOrders();
  res.json({ orders });
});

// Usage/observability dashboard data — raw per-turn records, JSON file backed.
// All aggregation/filtering happens client-side in public/dashboard.html.
app.get("/api/usage", (_req, res) => {
  res.json({ records: getAllUsage() });
});

app.post("/api/end/:sessionId", (req, res) => {
  const session = sessionStore.end(req.params.sessionId, req.body?.status || "ended");
  if (!session) return res.status(404).json({ error: "Unknown session" });
  res.json({ sessionId: session.id, status: session.status });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Voice ordering agent listening on http://localhost:${PORT}`);
});