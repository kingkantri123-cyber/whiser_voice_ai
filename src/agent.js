import Groq from "groq-sdk";
import { toolDeclarations, executeTool } from "./tools.js";
import { SYSTEM_INSTRUCTION } from "./systemPrompt.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const MAX_TOOL_ROUNDS = 6; // guard against a runaway tool-calling loop

// Rough token estimate (chars/4) used only to split a turn's real prompt_tokens
// total into categories for the dashboard -- not an exact tokenizer count.
function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

function toGroqTools() {
  return toolDeclarations.map((decl) => ({
    type: "function",
    function: {
      name: decl.name,
      description: decl.description,
      parameters: decl.parameters,
    },
  }));
}

/**
 * Runs one caller turn end-to-end: appends the user message to history,
 * loops through any tool calls the model makes, and returns the final
 * assistant text plus a log of every tool call made this turn.
 */
export async function runTurn(session, userText) {
  if (session.history.length === 0) {
    session.history.push({ role: "system", content: SYSTEM_INSTRUCTION });
  }
  session.history.push({ role: "user", content: userText });

  const toolCallLog = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let toolResultChars = 0;
  let rounds = 0;
  const startedAt = Date.now();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rounds += 1;
    const response = await groq.chat.completions.create({
      model: MODEL,
      messages: session.history,
      tools: toGroqTools(),
      tool_choice: "auto",
    });

    if (response.usage) {
      inputTokens += response.usage.prompt_tokens || 0;
      outputTokens += response.usage.completion_tokens || 0;
    }

    const message = response.choices?.[0]?.message;
    const toolCalls = message?.tool_calls || [];

    // Record the model's turn (text and/or tool calls) in history.
    session.history.push(message);

    if (toolCalls.length === 0) {
      const text = (message?.content || "").trim();
      const elapsedMs = Date.now() - startedAt;
      session.metrics.turns += 1;
      session.metrics.totalInputTokens += inputTokens;
      session.metrics.totalOutputTokens += outputTokens;
      session.metrics.turnLatenciesMs.push(elapsedMs);

      return {
        reply: text,
        toolCalls: toolCallLog,
        cart: session.cart.view(),
        metrics: {
          elapsedMs,
          inputTokens,
          outputTokens,
          rounds,
          tokenBreakdown: tokenBreakdown(inputTokens, userText, toolResultChars),
        },
        sessionStatus: session.status,
      };
    }

    // Execute every requested tool call, feed each result back as a
    // "tool" message keyed to its tool_call_id (Groq requires one
    // tool message per call, not a single combined turn like Gemini).
    for (const call of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      const result = executeTool(session, call.function.name, args);
      const resultJson = JSON.stringify(result);
      toolResultChars += resultJson.length;
      toolCallLog.push({ name: call.function.name, args, ok: !result.error, result });
      session.history.push({
        role: "tool",
        tool_call_id: call.id,
        content: resultJson,
      });
    }
  }

  // Safety valve: too many tool rounds without a final text reply.
  session.metrics.turns += 1;
  return {
    reply:
      "Sorry, I'm having trouble completing that -- could you repeat what you'd like?",
    toolCalls: toolCallLog,
    cart: session.cart.view(),
    metrics: {
      elapsedMs: Date.now() - startedAt,
      inputTokens,
      outputTokens,
      rounds,
      tokenBreakdown: tokenBreakdown(inputTokens, userText, toolResultChars),
    },
    sessionStatus: session.status,
    warning: "MAX_TOOL_ROUNDS exceeded",
  };
}

// Splits a turn's real prompt_tokens total into rough categories for the
// dashboard's context-growth chart. systemPrompt/currentRequest/toolData are
// estimated from source text; whatever's left is attributed to conversation
// history so the four figures always sum to the real inputTokens.
function tokenBreakdown(inputTokens, userText, toolResultChars) {
  const systemPromptTokens = estimateTokens(SYSTEM_INSTRUCTION);
  const currentRequestTokens = estimateTokens(userText);
  const toolDataTokens = Math.ceil(toolResultChars / 4);
  const accountedFor = systemPromptTokens + currentRequestTokens + toolDataTokens;
  const recentConversationTokens = Math.max(0, inputTokens - accountedFor);
  return { systemPromptTokens, currentRequestTokens, toolDataTokens, recentConversationTokens };
}