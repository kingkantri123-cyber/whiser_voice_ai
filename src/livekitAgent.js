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
  tts as ttsCore,
  stt as sttCore,
} from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import OpenAI from "openai";
import { OrpheusTTS } from "./orpheusTts.js";
import { ipv4Fetch } from "./ipv4Fetch.js";
import { toolDeclarations, executeTool } from "./tools.js";
import { sessionStore } from "./sessionStore.js";
import { saveOrder } from "./db.js";
import { recordUsage } from "./usageDb.js";
import { SYSTEM_INSTRUCTION } from "./systemPrompt.js";

const GREETING_TEXT =
  "Hi there, welcome! I'm the voice ordering assistant. Would you like to hear the menu or place an order?";

// openrouter.ai resolves to Cloudflare IPs with real AAAA (IPv6) records, and
// on this network Node's global fetch (undici) hangs racing IPv6 for it and
// never falls back to IPv4 in time -- every request times out at exactly the
// SDK's default 10s, even though the same host answers over IPv4 in ~2s
// (confirmed with curl and Node's `https` module directly). Groq/Deepgram
// never hit this because those hosts have no AAAA record, so undici only
// ever tried IPv4 for them. ipv4Fetch forces IPv4-only connections via
// `https`, sidestepping the bug without needing a new dependency (installing
// one isn't possible right now -- npm's registry hits the same IPv6 black
// hole).
//
// Also disables OpenRouter reasoning: Nemotron 3.5 Lightning reasons by
// default -- even a bare "hi" burns ~135 reasoning tokens before it answers
// (confirmed via a direct OpenRouter call), and with the full system prompt +
// tools in context that thinking phase runs long enough to look like the
// agent never replied. `reasoning: { enabled: false }` turns it off (0
// reasoning tokens, same/better answer quality, ~1.8s for a real order-turn
// prompt); the openai SDK has no constructor hook for extra body fields, so
// it's injected here at the fetch layer.
function openRouterFetch(url, init = {}) {
  if (typeof init.body === "string") {
    const body = JSON.parse(init.body);
    body.reasoning = { enabled: false };
    init = { ...init, body: JSON.stringify(body) };
  }
  return ipv4Fetch(url, init);
}

// Conversational LLM provider, switchable via LLM_PROVIDER in .env ("groq" or
// "openrouter", defaults to openrouter) -- lets a rate-limited or misbehaving
// provider be swapped without touching code. GROQ_MODEL/OPENROUTER_MODEL
// override the model slug for whichever provider is active.
function buildLLM() {
  const provider = (process.env.LLM_PROVIDER || "openrouter").toLowerCase();

  if (provider === "groq") {
    const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
    return { provider, model, llm: openai.LLM.withGroq({ model }) };
  }

  if (provider === "openrouter") {
    const model = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3.5-lightning";
    return {
      provider,
      model,
      llm: new openai.LLM({
        model,
        client: new OpenAI({
          apiKey: process.env.OPENROUTER_API_KEY,
          baseURL: "https://openrouter.ai/api/v1",
          fetch: openRouterFetch,
        }),
      }),
    };
  }

  throw new Error(`Unknown LLM_PROVIDER "${provider}" -- expected "groq" or "openrouter"`);
}

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
function attachUsageTracking(agentSession, sessionId, { llmProvider, llmModel }) {
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

    recordUsage({
      sessionId,
      durationMs: (pending.stt?.durationMs || 0) + (pending.llm?.durationMs || 0) + (pending.tts?.durationMs || 0),
      status: "success",
      stt: pending.stt && {
        provider: pending.stt.label?.toLowerCase().includes("deepgram") ? "deepgram" : "groq",
        model: pending.stt.label?.toLowerCase().includes("deepgram") ? "nova-3" : "whisper-large-v3-turbo",
        latencyMs: pending.stt.durationMs,
        audioSeconds: (pending.stt.audioDurationMs || 0) / 1000,
        status: "ok",
      },
      llm: pending.llm && {
        provider: llmProvider,
        model: llmModel,
        latencyMs: pending.llm.durationMs,
        inputTokens: pending.llm.promptTokens,
        outputTokens: pending.llm.completionTokens,
        toolCalls: pending.toolCalls,
        status: "ok",
      },
      tts: pending.tts && {
        provider: pending.tts.label?.toLowerCase().includes("deepgram") ? "deepgram" : "canopy",
        // Deepgram is the FallbackAdapter's primary; anything else means it fell over.
        usedFallback: !pending.tts.label?.toLowerCase().includes("deepgram"),
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

  if (!process.env.DEEPGRAM_API_KEY) {
    throw new Error("DEEPGRAM_API_KEY is required while Deepgram TTS is the primary provider");
  }

  // Deepgram Aura is primary, with Groq Orpheus (Canopy) as a real fallback --
  // Orpheus/Canopy has been unreliable (timeouts, see groqServices.js's
  // generateSpeech()), so it's demoted to backup instead of dropped entirely.
  // Unlike the STT FallbackAdapter, TTS synthesize()/stream() failures do
  // propagate as real errors, so this fallback actually triggers.
  const ttsWithFallback = new ttsCore.FallbackAdapter({
    ttsInstances: [
      new deepgram.TTS({ model: "aura-asteria-en" }),
      new OrpheusTTS(),
    ],
  });

  // Deepgram is primary here, Groq Whisper is the fallback -- the reverse of
  // what you'd expect. Groq's Whisper STT is a plain batch endpoint, so
  // AgentSession wraps it in a StreamAdapterWrapper; when that wrapper's
  // recognize() call fails (eg. times out, which happens under the live
  // call's higher request rate against Groq's rate limit), it just logs and
  // drops the utterance instead of emitting an `error` event
  // (node_modules/@livekit/agents/dist/stt/stream_adapter.js), so
  // FallbackAdapter never sees a failure to fall over on and the caller's
  // speech is silently lost. Deepgram is real streaming, so its failures
  // surface as genuine stream errors that FallbackAdapter can act on -- put
  // it first so a real failure is actually catchable, and keep Groq as a
  // backup for when Deepgram itself is down.
  const sttWithFallback = new sttCore.FallbackAdapter({
    sttInstances: [
      new deepgram.STT(),
      openai.STT.withGroq({ model: "whisper-large-v3-turbo" }),
    ],
    vad,
  });

  const { llm, provider: llmProvider, model: llmModel } = buildLLM();

  const agentSession = new AgentSession({
    vad,
    stt: sttWithFallback,
    llm,
    tts: ttsWithFallback,
  });

  attachUsageTracking(agentSession, sessionId, { llmProvider, llmModel });

  await agentSession.start({
    agent: new Agent({
      instructions: SYSTEM_INSTRUCTION,
      tools: buildTools(session, ctx.room),
    }),
    room: ctx.room,
  });

  // Speak the greeting directly through TTS instead of generateReply() --
  // generateReply() round-trips through the LLM to compose the greeting
  // before it can be synthesized, which adds latency for a line that's
  // always the same. say() sends the fixed text straight to TTS, and still
  // records it in chat context so later turns see it as history.
  agentSession.say(GREETING_TEXT, { addToChatCtx: true });
}

cli.runApp(new WorkerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: process.env.LIVEKIT_AGENT_NAME || "voice-order-agent",
  // Lets a second worker instance run alongside another on the same machine
  // (default internal health-check port is 8081 for both).
  port: process.env.LIVEKIT_WORKER_PORT ? Number(process.env.LIVEKIT_WORKER_PORT) : undefined,
}));
