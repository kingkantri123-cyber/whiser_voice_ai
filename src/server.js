import "dotenv/config";
import express from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { sessionStore } from "./sessionStore.js";
import { runTurn } from "./agent.js";
import { transcribeAudio, generateSpeech } from "./groqServices.js";
import { preprocessAudio } from "./audioProcessing.js";
import { saveOrder, getAllOrders } from "./db.js";
import { saveCallUsage, getAllCallUsage } from "./tokenUsageDb.js";
import { aggregateUsage, estimateCost, scaleEstimate } from "./costEstimator.js";

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

  try {
    // Step 1a: backend audio normalization (highpass, loudness-normalize,
    // trim silence, downmix to 16kHz mono). Falls back to the raw upload
    // if ffmpeg chokes on a malformed clip, so one bad file can't 500 the call.
    let sttBuffer = audioFile.buffer;
    let sttMime = audioFile.mimetype;
    try {
      sttBuffer = await preprocessAudio(audioFile.buffer);
      sttMime = "audio/wav";
    } catch (preprocessErr) {
      console.warn("Audio preprocessing failed, using raw upload:", preprocessErr.message);
    }

    // Step 1b: STT via Groq Whisper
    const userText = await transcribeAudio(sttBuffer, sttMime, session.usageMonitor);

    // Step 2: Agent processing via Gemini
    const agentResult = await runTurn(session, userText);

    // Step 3: TTS via Groq Orpheus
    console.log(`Generating speech for text: "${agentResult.reply}"`);
    const audioBuffer = await generateSpeech(agentResult.reply, "hannah", session.usageMonitor);
    console.log(`Speech generated successfully. Buffer size: ${audioBuffer.length} bytes`);

    // Persist order to JSON DB if it was just placed this turn
    if (agentResult.cart?.placed) {
      const session = sessionStore.get(sessionId);
      if (session) saveOrder(session);
    }

    // Return agent JSON payload along with Base64 audio
    res.json({
      sessionId,
      userText,
      replyText: agentResult.reply,
      audioBase64: audioBuffer.toString("base64"),
      toolCalls: agentResult.toolCalls,
      cart: agentResult.cart,
      metrics: agentResult.metrics,
      usage: session.usageMonitor.toJSON(),
      sessionStatus: agentResult.sessionStatus,
    });
  } catch (err) {
    console.error("Voice pipeline error:", err);
    res.status(500).json({ error: "Voice processing failed", detail: err.message });
  }
});

// Standalone TTS Endpoint
app.post("/api/tts", async (req, res) => {
  const { text, voice } = req.body;
  if (!text) return res.status(400).json({ error: "Text is required" });

  try {
    const audioBuffer = await generateSpeech(text, voice);
    res.setHeader("Content-Type", "audio/wav");
    res.send(audioBuffer);
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
    const audioBuffer = await generateSpeech(greeting);
    res.json({ audioBase64: audioBuffer.toString("base64"), text: greeting });
  } catch (err) {
    res.status(500).json({ error: "Greeting failed", detail: err.message });
  }
});

// Orders — merged from in-memory store + persisted DB
app.get("/api/orders", (_req, res) => {
  const orders = getAllOrders();
  res.json({ orders });
});

app.get("/api/token-usage", (_req, res) => {
  res.json({ calls: getAllCallUsage() });
});

app.get("/api/usage-dashboard", (_req, res) => {
  const allCalls = getAllCallUsage();
  const from = Date.parse(_req.query.from || "");
  const to = Date.parse(_req.query.to || "");
  const calls = allCalls.filter((call) => {
    const timestamp = Date.parse(call.endedAt || call.startedAt || call.savedAt);
    return (!_req.query.sessionId || call.sessionId === _req.query.sessionId) &&
      (!Number.isFinite(from) || timestamp >= from) && (!Number.isFinite(to) || timestamp < to);
  });
  const summary = aggregateUsage(calls);
  const firstCall = calls.map((call) => Date.parse(call.startedAt)).filter(Number.isFinite).sort()[0];
  const daysObserved = firstCall ? Math.max(1, (Date.now() - firstCall) / 86_400_000) : 1;
  const dailyCost = estimateCost(summary);
  res.json({
    usage: summary,
    pricing: dailyCost.rates,
    estimatedCost: {
      observedWindow: dailyCost,
      daily: dailyCost.total == null ? null : dailyCost.total / daysObserved,
      weekly: scaleEstimate(dailyCost.total == null ? null : dailyCost.total / daysObserved, 7),
      monthly: scaleEstimate(dailyCost.total == null ? null : dailyCost.total / daysObserved, 30),
      yearly: scaleEstimate(dailyCost.total == null ? null : dailyCost.total / daysObserved, 365),
    },
    calls: calls.length,
    daysObserved,
  });
});

app.post("/api/end/:sessionId", (req, res) => {
  const session = sessionStore.end(req.params.sessionId, req.body?.status || "ended");
  if (!session) return res.status(404).json({ error: "Unknown session" });
  const usage = saveCallUsage(session);
  session.usageMonitor.printDashboard();
  res.json({ sessionId: session.id, status: session.status, usage });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Voice ordering agent listening on http://localhost:${PORT}`);
});