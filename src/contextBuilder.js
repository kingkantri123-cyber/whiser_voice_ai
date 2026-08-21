import Groq from "groq-sdk";
import { elapsedMs, startTimer } from "./usageMonitor.js";

let groq;

function getGroq() {
  if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq;
}
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const MAX_CONTEXT_TOKENS = Number(process.env.MAX_CONTEXT_TOKENS || 3500);
const RECENT_TURN_COUNT = Number(process.env.RECENT_TURN_COUNT || 6);
const SUMMARY_TRIGGER_TOKENS = Number(process.env.SUMMARY_TRIGGER_TOKENS || 2500);
const MAX_SUMMARY_TOKENS = Number(process.env.MAX_SUMMARY_TOKENS || 400);

const estimateTokens = (value) => Math.ceil(String(value || "").length / 4);

function compactOptionGroups(groups = []) {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    required: Boolean(group.required),
    min: group.min,
    max: group.max,
    options: (group.options || []).map((option) => ({
      id: option.id,
      name: option.name,
      priceDelta: option.priceDelta,
      nestedOptionGroups: option.nestedOptionGroups
        ? compactOptionGroups(option.nestedOptionGroups)
        : undefined,
    })),
  }));
}

function compactItem(item) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    basePrice: item.basePrice,
    optionGroups: compactOptionGroups(item.optionGroups),
  };
}

function compactLine(line) {
  if (!line) return null;
  return {
    cartItemId: line.cartItemId,
    itemId: line.itemId,
    itemName: line.itemName,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
    chosen: line.chosen,
  };
}

function compactToolResult(content) {
  try {
    const value = JSON.parse(content);
    if (value.error) return JSON.stringify({ error: value.error, code: value.code });
    if (value.item) return JSON.stringify({ item: compactItem(value.item) });
    if (value.categories) return JSON.stringify({ categories: value.categories.map((category) => ({
      id: category.id,
      name: category.name,
      items: category.items?.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        basePrice: item.basePrice,
      })),
    })) });
    if (value.cartTotal !== undefined) return JSON.stringify({
      cartTotal: value.cartTotal,
      added: compactLine(value.added),
      updated: compactLine(value.updated),
      placed: value.placed,
    });
    if (value.lines || value.total !== undefined) return JSON.stringify({
      lines: value.lines?.map(compactLine),
      total: value.total,
      placed: value.placed,
    });
    return JSON.stringify(value);
  } catch {
    return String(content).slice(0, 1600);
  }
}

function compactMessage(message) {
  if (message.role === "tool") return { ...message, content: compactToolResult(message.content) };
  if (message.role === "assistant" && message.tool_calls) {
    return { role: "assistant", tool_calls: message.tool_calls };
  }
  return message;
}

function messageTokens(messages) {
  return messages.reduce((total, message) => total + estimateTokens(JSON.stringify(message)), 0);
}

function contextAnalysis(messages, debug = {}) {
  const count = (role) => messages.filter((message) => message.role === role).length;
  const toolCalls = messages.reduce((total, message) => total + (message.tool_calls?.length || 0), 0);
  return {
    messageCount: messages.length,
    systemMessages: count("system"),
    userMessages: count("user"),
    assistantMessages: count("assistant"),
    toolCalls,
    toolResults: count("tool"),
    estimatedTokens: messageTokens(messages),
    systemTokens: messageTokens(messages.filter((message) => message.role === "system")),
    summaryTokens: debug.summaryTokens || 0,
    recentConversationTokens: debug.recentContextTokens || 0,
    recentMessageTokens: debug.recentContextTokens || 0,
    toolTokens: messageTokens(messages.filter((message) => message.role === "tool" || message.tool_calls)),
    currentRequestTokens: debug.currentRequestTokens || 0,
    fullHistoryMessageCount: debug.fullHistoryMessageCount || messages.length,
    olderMessagesSummarized: debug.olderMessagesSummarized || 0,
    contextLimit: debug.contextLimit || null,
    // Tool/function schemas sent via the API's `tools` param aren't part of
    // `messages` at all, but Groq counts them in prompt_tokens on every call.
    // Passed in by the caller (agent.js) since only it knows the tool payload.
    toolSchemaTokens: debug.toolSchemaTokens || 0,
    estimatedFullRequestTokens: messageTokens(messages) + (debug.toolSchemaTokens || 0),
  };
}

function makeBlocks(messages, startIndex) {
  const blocks = [];
  let current = [];
  for (let index = startIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user" && current.length) {
      blocks.push({ messages: current, startIndex: index - current.length });
      current = [];
    }
    current.push(message);
  }
  if (current.length) blocks.push({ messages: current, startIndex: messages.length - current.length });
  return blocks;
}

function summaryMessage(summary) {
  return summary ? [{ role: "system", content: `Conversation summary:\n${summary}` }] : [];
}

async function summarizeMessages(session, messages) {
  if (!messages.length) return session.contextSummary || "";
  const oldContext = messages.map((message) => compactMessage(message));
  const prompt = [
    "Update the compact restaurant-order conversation summary below.",
    "Preserve intent, decisions, preferences, order state, unresolved questions, important entities, constraints, and commitments.",
    "Remove greetings, filler, repeated explanations, and raw tool details that are not needed to continue.",
    "Return only the concise summary, with no preamble.",
    `Existing summary:\n${session.contextSummary || "(none)"}`,
    `New older messages:\n${JSON.stringify(oldContext)}`,
  ].join("\n\n");
  const startedAt = startTimer();
  const context = contextAnalysis([
    { role: "system", content: "You compress conversation memory for a voice ordering assistant." },
    { role: "user", content: prompt },
  ]);
  try {
    const response = await getGroq().chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: "You compress conversation memory for a voice ordering assistant." },
        { role: "user", content: prompt },
      ],
      max_completion_tokens: MAX_SUMMARY_TOKENS,
      temperature: 0,
    });
    session.usageMonitor?.recordLlm({
      model: MODEL,
      usage: response.usage,
      latency: elapsedMs(startedAt),
      status: "success",
      response,
      purpose: "context_summary",
      context,
    });
    return (response.choices?.[0]?.message?.content || session.contextSummary || "").trim();
  } catch (error) {
    session.usageMonitor?.recordLlm({
      model: MODEL,
      latency: elapsedMs(startedAt),
      status: "failure",
      error: error.message,
      purpose: "context_summary",
      context,
    });
    return session.contextSummary || "";
  }
}

export async function buildLLMContext(session, turnStartIndex, { summarize = summarizeMessages, toolSchemaTokens = 0 } = {}) {
  const history = session.history;
  const system = history[0]?.role === "system" ? history[0] : null;
  const storedStart = system ? 1 : 0;
  const completedMessages = history.slice(storedStart, turnStartIndex);
  const completedTokens = messageTokens(completedMessages);
  const completedHistory = history.slice(0, turnStartIndex);
  const blocks = makeBlocks(completedHistory, storedStart);

  if (completedTokens > SUMMARY_TRIGGER_TOKENS && blocks.length > RECENT_TURN_COUNT) {
    const cutoffBlock = Math.max(0, blocks.length - RECENT_TURN_COUNT);
    const cutoffIndex = blocks[cutoffBlock]?.startIndex ?? turnStartIndex;
    const summaryStart = Math.max(storedStart, session.contextSummaryMessageCount || storedStart);
    const messagesToSummarize = history.slice(summaryStart, cutoffIndex);
    if (messagesToSummarize.length) {
      session.contextSummary = await summarize(session, messagesToSummarize);
      session.contextSummaryMessageCount = cutoffIndex;
    }
  }

  const recentStart = Math.max(storedStart, session.contextSummaryMessageCount || storedStart);
  const recentMessages = history.slice(recentStart, turnStartIndex).map(compactMessage);
  // Compact this turn's own tool-loop messages too. Without this, every raw
  // tool result and every extra field on the assistant's tool_calls message
  // (from THIS turn) gets re-sent in full on every subsequent round of the
  // same turn, growing faster than the recent-history messages do.
  const activeMessages = history.slice(turnStartIndex).map(compactMessage);
  const summary = summaryMessage(session.contextSummary);
  const baseMessages = [system, ...summary, ...recentMessages, ...activeMessages].filter(Boolean);
  let messages = baseMessages;

  while (messageTokens(messages) + toolSchemaTokens > MAX_CONTEXT_TOKENS && recentMessages.length > 2) {
    recentMessages.shift();
    messages = [system, ...summary, ...recentMessages, ...activeMessages].filter(Boolean);
  }

  const debug = {
    fullHistoryMessageCount: history.length,
    contextMessageCount: messages.length,
    recentMessagesIncluded: recentMessages.length,
    olderMessagesSummarized: Math.max(0, (session.contextSummaryMessageCount || storedStart) - storedStart),
    toolMessagesIncluded: messages.filter((message) => message.role === "tool").length,
    estimatedContextTokens: messageTokens(messages),
    summaryTokens: estimateTokens(session.contextSummary),
    recentContextTokens: messageTokens(recentMessages),
    currentRequestTokens: messageTokens(activeMessages.filter((message) => message.role === "user")),
    contextLimit: MAX_CONTEXT_TOKENS,
    toolSchemaTokens,
  };
  debug.context = contextAnalysis(messages, debug);
  session.contextDebug = debug;
  return { messages, debug };
}

export { estimateTokens };

export const contextConfig = {
  MAX_CONTEXT_TOKENS,
  RECENT_TURN_COUNT,
  SUMMARY_TRIGGER_TOKENS,
  MAX_SUMMARY_TOKENS,
};