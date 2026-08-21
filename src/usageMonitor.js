import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

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
    this.currentTurn = null;
  }

  beginTurn(turnId) {
    this.currentTurn = { turnId, requestIndex: 0, toolCalls: [], toolSessions: [] };
  }

  endTurn() {
    if (this.currentTurn) {
      this.record({
        type: "turn",
        turnId: this.currentTurn.turnId,
        toolCalls: this.currentTurn.toolCalls,
        toolSessions: this.currentTurn.toolSessions,
      });
    }
    this.currentTurn = null;
  }

  record(event) {
    this.events.push({ timestamp: timestamp(), ...event });
  }

  recordToolCall({ round, toolName, argumentsFingerprint }) {
    if (!this.currentTurn) return;
    this.currentTurn.toolCalls.push({
      round,
      toolName,
      requestIndex: this.currentTurn.requestIndex,
      argumentsFingerprint,
    });
    const session = this.currentTurn.toolSessions.find((item) => item.requestIndex === this.currentTurn.requestIndex);
    session?.tools.push({ toolName, argumentsFingerprint });
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

  recordLlm({ model, usage, latency, status, error, response, context, purpose, toolRound }) {
    const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
    const turn = this.currentTurn;
    const requestIndex = turn ? ++turn.requestIndex : null;
    const resolvedToolRound = toolRound ?? turn?.toolRound ?? 0;
    const normalizedError = error
      ? { type: error.type || error.name || "Error", message: error.message || String(error) }
      : null;
    const event = {
      type: "llm",
      requestId: randomUUID(),
      turnId: turn?.turnId || null,
      requestIndex,
      model,
      inputTokens,
      outputTokens,
      totalTokens: usage?.total_tokens ?? inputTokens + outputTokens,
      latencyMs: latency,
      toolRound: resolvedToolRound,
      isToolRound: resolvedToolRound > 0,
      status,
      error: normalizedError,
      rawUsage: usage || null,
      purpose: purpose || "conversation",
      context: context || null,
      rateLimitHeaders: getResponseHeaders(response),
    };
    this.record(event);
    if (turn) {
      turn.toolSessions.push({
        round: resolvedToolRound,
        requestIndex,
        inputTokens,
        outputTokens,
        totalTokens: event.totalTokens,
        status,
        error: normalizedError,
        tools: [],
      });
    }
    return event;
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
    const llmEvents = this.events.filter((event) => event.type === "llm");
    const summary = this.summary();
    const turns = [...new Set(llmEvents.map((event) => event.turnId).filter(Boolean))].map((turnId) => {
      const requests = llmEvents.filter((event) => event.turnId === turnId);
      const turnEvent = this.events.find((event) => event.type === "turn" && event.turnId === turnId);
      const inputs = requests.map((request) => Number(request.inputTokens) || 0);
      const sum = (field) => requests.reduce((total, request) => total + (Number(request[field]) || 0), 0);
      return {
        turnId,
        llmRequests: requests.length,
        inputTokens: sum("inputTokens"),
        outputTokens: sum("outputTokens"),
        totalTokens: sum("totalTokens"),
        analysis: {
          toolRounds: Math.max(...requests.map((request) => request.toolRound), 0),
          maxContextTokens: Math.max(...inputs, 0),
          minContextTokens: Math.min(...inputs, 0),
          averageContextTokens: inputs.length ? inputs.reduce((total, value) => total + value, 0) / inputs.length : 0,
        },
        toolAnalysis: analyzeToolChain(turnEvent?.toolCalls || [], requests, turnEvent?.toolSessions || []),
        tool_analysis: analyzeToolChain(turnEvent?.toolCalls || [], requests, turnEvent?.toolSessions || []),
        requests,
      };
    });
    return {
      sessionId: this.sessionId,
      summary: { ...summary, llm: { ...summary.llm, requests: llmEvents } },
      llm: { requests: llmEvents },
      turns,
      events: this.events,
    };
  }

}

function analyzeToolChain(toolCalls, requests, toolSessions = []) {
  const counts = toolCalls.reduce((map, call) => map.set(call.toolName, (map.get(call.toolName) || 0) + 1), new Map());
  const repeatedTools = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([toolName, count]) => ({ toolName, count }));
  const classification = repeatedTools.length ? "POTENTIALLY OPTIMIZABLE" : "NECESSARY";
  const argumentCounts = toolCalls.reduce((map, call) => map.set(call.argumentsFingerprint, (map.get(call.argumentsFingerprint) || 0) + 1), new Map());
  const sameParameterCalls = [...argumentCounts.values()].filter((count) => count > 1).reduce((total, count) => total + count - 1, 0);
  const independentPairs = [];
  for (let index = 1; index < toolCalls.length; index += 1) {
    const previous = toolCalls[index - 1].toolName;
    const current = toolCalls[index].toolName;
    if (canRunIndependently(previous, current)) independentPairs.push({ previous, current });
  }
  const finalClassification = repeatedTools.length || independentPairs.length
    ? "POTENTIALLY OPTIMIZABLE"
    : classification;
  const toolRequestIndexes = new Set(toolCalls.map((call) => call.requestIndex));
  const toolRequests = requests.filter((request) => toolRequestIndexes.has(request.requestIndex));
  const sum = (items, field) => items.reduce((total, item) => total + (Number(item[field]) || 0), 0);
  return {
    toolRounds: new Set(toolCalls.map((call) => call.round)).size,
    llmRequests: requests.length,
    toolCalls: toolCalls.length,
    uniqueTools: counts.size,
    repeatedToolCalls: repeatedTools.reduce((total, item) => total + item.count - 1, 0),
    sameParameterCalls,
    repeatedTools,
    failedLlmRequests: requests.filter((request) => request.status === "failure").length,
    toolRoundInputTokens: sum(toolRequests, "inputTokens"),
    toolRoundOutputTokens: sum(toolRequests, "outputTokens"),
    toolSessions,
    classification: finalClassification,
    potentiallyIndependentPairs: independentPairs,
    reasons: repeatedTools.length
      ? ["A tool was called more than once in this turn; inspect whether later calls depend on changed state or repeat the same lookup."]
      : independentPairs.length
        ? ["Sequential tools include an independent pair that could potentially be requested in the same model round; no execution behavior was changed."]
      : toolCalls.length > 1
        ? ["The tools were executed in sequential model rounds; this is treated as dependency-driven without speculative execution."]
        : [],
    tools: toolCalls,
  };
}

function canRunIndependently(previous, current) {
  const contact = previous === "record_contact_info" || current === "record_contact_info";
  const menuLookup = new Set(["list_menu", "get_item_details"]);
  const cartRead = previous === "view_cart" || current === "view_cart";
  return contact && !cartRead && !menuLookup.has(previous) && !menuLookup.has(current);
}
