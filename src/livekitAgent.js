import "dotenv/config";
import { fileURLToPath } from "node:url";
import {
  defineAgent,
  cli,
  WorkerOptions,
  Agent,
  AgentSession,
  AgentSessionEventTypes,
  tool,
} from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import * as deepgram from "@livekit/agents-plugin-deepgram";
// import { OrpheusTTS } from "./orpheusTts.js"; -- swap back in when reverting to Groq Orpheus TTS
import { toolDeclarations, executeTool } from "./tools.js";
import { sessionStore } from "./sessionStore.js";
import { saveOrder } from "./db.js";
import { recordUsage } from "./usageDb.js";
import { SYSTEM_INSTRUCTION } from "./systemPrompt.js";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// Wraps tools.js's existing JSON-schema tool declarations + dispatcher for
// the Agents framework's `tool()` helper. No menu/cart logic is duplicated
// here -- executeTool(session, name, args) is the same function the legacy
// HTTP pipeline (agent.js) calls.
function buildTools(session, room) {
  const tools = {};
  for (const decl of toolDeclarations) {
    tools[decl.name] = tool({
      description: decl.description,
      parameters: decl.parameters,
      execute: async (args) => {
        const result = executeTool(session, decl.name, args);
        if (decl.name === "place_order" && result?.placed) {
          saveOrder(session);
        }
        if (["add_to_cart", "update_cart_item", "remove_from_cart", "place_order"].includes(decl.name)) {
          publishCart(room, session);
        }
        return result;
      },
    });
  }
  return tools;
}

function publishCart(room, session) {
  const payload = JSON.stringify({ type: "cart", cart: session.cart.view() });
  room?.localParticipant?.publishData(new TextEncoder().encode(payload), { reliable: true }).catch(() => {});
}

// Accumulates the most recent metric of each stage plus any tool calls seen
// since the last flush, then logs one usage record per assistant turn --
// mirrors the shape server.js's /api/voice-chat writes via usageDb.js, so
// public/dashboard.html works the same regardless of which pipeline ran.
function attachUsageTracking(agentSession, sessionId) {
  const pending = { stt: null, llm: null, tts: null, toolCalls: [] };

  agentSession.on(AgentSessionEventTypes.MetricsCollected, ({ metrics }) => {
    if (metrics.type === "stt_metrics") pending.stt = metrics;
    else if (metrics.type === "llm_metrics") pending.llm = metrics;
    else if (metrics.type === "tts_metrics") pending.tts = metrics;
  });

  agentSession.on(AgentSessionEventTypes.FunctionToolsExecuted, ({ functionCalls, functionCallOutputs }) => {
    functionCalls.forEach((call, i) => {
      const output = functionCallOutputs[i];
      pending.toolCalls.push({ name: call.name, ok: !output?.isError });
    });
  });

  agentSession.on(AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== "message" || item.role !== "assistant") return;

    // No FallbackAdapter is configured right now (Deepgram is the sole,
    // temporary primary TTS) so there's nothing to detect a fallback from --
    // every completed turn is "success" here. Re-add fallback detection if a
    // FallbackAdapter goes back in.
    recordUsage({
      sessionId,
      durationMs: (pending.stt?.durationMs || 0) + (pending.llm?.durationMs || 0) + (pending.tts?.durationMs || 0),
      status: "success",
      stt: pending.stt && {
        provider: "groq",
        model: "whisper-large-v3-turbo",
        latencyMs: pending.stt.durationMs,
        audioSeconds: (pending.stt.audioDurationMs || 0) / 1000,
        status: "ok",
      },
      llm: pending.llm && {
        provider: "groq",
        model: MODEL,
        latencyMs: pending.llm.durationMs,
        inputTokens: pending.llm.promptTokens,
        outputTokens: pending.llm.completionTokens,
        toolCalls: pending.toolCalls,
        status: "ok",
      },
      tts: pending.tts && {
        provider: pending.tts.label?.toLowerCase().includes("deepgram") ? "deepgram" : "canopy",
        usedFallback: false,
        characters: pending.tts.charactersCount,
        latencyMs: pending.tts.durationMs,
        status: "ok",
      },
    });

    pending.stt = null;
    pending.llm = null;
    pending.tts = null;
    pending.toolCalls = [];
  });

  agentSession.on(AgentSessionEventTypes.Close, () => {
    sessionStore.end(sessionId);
  });
}

export default defineAgent({
  // Runs once per worker job process, before any job is assigned to it --
  // loading the VAD model here instead of per-call shaves that load time off
  // every call's greeting latency.
  prewarm: async (proc) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx) => {
    try {
      await runEntry(ctx);
    } catch (err) {
      // Without this, a throw anywhere in here just stalls the caller on
      // "Listening..." with nothing printed -- the job fails on LiveKit's
      // side but there's no client-visible error.
      console.error("[livekitAgent] job failed for room", ctx.room?.name, err);
      throw err;
    }
  },
});

async function runEntry(ctx) {
  await ctx.connect();

  const sessionId = ctx.room.name.replace(/^call-/, "");
  const session = sessionStore.getOrCreate(sessionId);

  const vad = ctx.proc.userData.vad;

  // TEMPORARY: Deepgram Aura is the primary TTS for now instead of Groq
  // Orpheus (OrpheusTTS, still in ./orpheusTts.js) -- swap the `tts:` line
  // below back to `new OrpheusTTS(...)` to revert.
  if (!process.env.DEEPGRAM_API_KEY) {
    throw new Error("DEEPGRAM_API_KEY is required while Deepgram TTS is the primary provider");
  }
  const primaryTTS = new deepgram.TTS({ model: "aura-asteria-en" });

  const agentSession = new AgentSession({
    vad,
    stt: openai.STT.withGroq({ model: "whisper-large-v3-turbo" }),
    llm: openai.LLM.withGroq({ model: MODEL }),
    tts: primaryTTS,
  });

  attachUsageTracking(agentSession, sessionId);

  await agentSession.start({
    agent: new Agent({
      instructions: SYSTEM_INSTRUCTION,
      tools: buildTools(session, ctx.room),
    }),
    room: ctx.room,
  });

  await agentSession.generateReply({
    instructions:
      "Greet the caller: welcome them, say you're the voice ordering assistant, and ask if they'd like to hear the menu or place an order.",
  });
}

cli.runApp(new WorkerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: process.env.LIVEKIT_AGENT_NAME || "voice-order-agent",
  // Lets a second worker instance run alongside another on the same machine
  // (default internal health-check port is 8081 for both).
  port: process.env.LIVEKIT_WORKER_PORT ? Number(process.env.LIVEKIT_WORKER_PORT) : undefined,
}));
