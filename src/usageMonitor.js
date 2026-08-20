import { performance } from "node:perf_hooks";

const STT_MODEL = "whisper-large-v3-turbo";
const ORPHEUS_MODEL = "canopylabs/orpheus-v1-english";
const DEEPGRAM_MODEL = "aura-asteria-en";

function timestamp() {
  return new Date().toISOString();
}

function latencyMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function getResponseHeaders(response) {
  if (!response?.headers || typeof response.headers.entries !== "function") return null;
  return Object.fromEntries(response.headers.entries());
}

export function startTimer() {
  return performance.now();
}

export function elapsedMs(startedAt) {
  return latencyMs(startedAt);
}

export function wavDurationSeconds(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  if (!channels || !sampleRate || !bitsPerSample) return null;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") {
      const bytesPerSecond = sampleRate * channels * bitsPerSample / 8;
      return bytesPerSecond ? Math.round((size / bytesPerSecond) * 1000) / 1000 : null;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

export class UsageMonitor {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.events = [];
  }

  record(event) {
    this.events.push({ timestamp: timestamp(), ...event });
  }

  recordStt({ audioBuffer, text = "", latency, status, error, response }) {
    this.record({
      type: "stt",
      model: STT_MODEL,
      audioSeconds: wavDurationSeconds(audioBuffer),
      audioBytes: audioBuffer?.length || 0,
      charactersReturned: text.length,
      latencyMs: latency,
      status,
      error: error || null,
      responseMetadata: response?.usage || null,
      rateLimitHeaders: getResponseHeaders(response),
    });
  }

  recordLlm({ model, usage, latency, status, error, response }) {
    const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
    this.record({
      type: "llm",
      model,
      inputTokens,
      outputTokens,
      totalTokens: usage?.total_tokens ?? inputTokens + outputTokens,
      latencyMs: latency,
      status,
      error: error || null,
      rawUsage: usage || null,
      rateLimitHeaders: getResponseHeaders(response),
    });
  }

  recordTts({ provider, model, voice, text, latency, status, fallbackTriggered, fallbackReason, error, response }) {
    this.record({
      type: "tts",
      provider,
      model,
      voice: voice || null,
      role: fallbackTriggered ? "fallback TTS" : "primary TTS",
      charactersSent: text.length,
      latencyMs: latency,
      status,
      fallbackTriggered: Boolean(fallbackTriggered),
      fallbackReason: fallbackReason || null,
      error: error || null,
      rateLimitHeaders: getResponseHeaders(response),
    });
  }

  summary() {
    const stt = this.events.filter((event) => event.type === "stt");
    const llm = this.events.filter((event) => event.type === "llm");
    const tts = this.events.filter((event) => event.type === "tts");
    const total = (items, field) => items.reduce((sum, item) => sum + (Number(item[field]) || 0), 0);
    const primary = tts.filter((event) => event.role === "primary TTS");
    const fallback = tts.filter((event) => event.role === "fallback TTS");

    return {
      stt: {
        model: STT_MODEL,
        requests: stt.length,
        audioSeconds: total(stt, "audioSeconds"),
        audioMinutes: total(stt, "audioSeconds") / 60,
        audioHours: total(stt, "audioSeconds") / 3600,
      },
      llm: {
        models: [...new Set(llm.map((event) => event.model))],
        requests: llm.length,
        inputTokens: total(llm, "inputTokens"),
        outputTokens: total(llm, "outputTokens"),
        totalTokens: total(llm, "totalTokens"),
      },
      tts: {
        primaryModel: ORPHEUS_MODEL,
        primaryRequests: primary.length,
        primaryCharacters: total(primary, "charactersSent"),
        fallbackModel: DEEPGRAM_MODEL,
        fallbackRequests: fallback.length,
        fallbackCharacters: total(fallback, "charactersSent"),
      },
    };
  }

  toJSON() {
    return { sessionId: this.sessionId, summary: this.summary(), events: this.events };
  }

  printDashboard() {
    const summary = this.summary();
    console.log(`VOICE ASSISTANT USAGE\n==============================\nSTT requests=${summary.stt.requests} audio=${summary.stt.audioSeconds}s (${summary.stt.audioMinutes}m)\nLLM requests=${summary.llm.requests} input=${summary.llm.inputTokens} output=${summary.llm.outputTokens} total=${summary.llm.totalTokens}\nTTS primary requests=${summary.tts.primaryRequests} characters=${summary.tts.primaryCharacters}\nTTS fallback requests=${summary.tts.fallbackRequests} characters=${summary.tts.fallbackCharacters}`);
  }
}
