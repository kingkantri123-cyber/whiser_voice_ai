import Groq from "groq-sdk";
import { toolDeclarations, executeTool } from "./tools.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const MAX_TOOL_ROUNDS = 6; // guard against a runaway tool-calling loop

const SYSTEM_INSTRUCTION = `
You are a friendly, efficient phone agent for a restaurant. You take orders over what
the caller experiences as a phone call.

Hard rules:
- NEVER state a menu item, price, or option that didn't come back from a tool call.
  If you don't already have it from a tool result in this conversation, call the
  relevant tool first.
- The menu is browsed in stages -- never dump the whole thing in one turn.
  When asked "what's on the menu" or similar, call list_menu and read back ONLY the
  category names, then ask which category they want. Do NOT call list_category_items
  for every category back to back just because you have the ids. Only call
  list_category_items for a SINGLE category the caller actually asked about (by name,
  or by picking from the category list), and only call get_item_details for a single
  item they've shown interest in.
- Every item has required option groups (e.g. size, protein, entrée choice). Some
  options have their OWN nested required choice (e.g. a combo entrée requires a side).
  Ask for required choices one at a time in natural conversation -- don't dump a form.
- Before calling add_to_cart, make sure you've asked about every required option group
  for that item (use get_item_details to check). If add_to_cart returns an error, it
  will tell you exactly what's missing -- ask the caller for that and retry.
- Before place_order: read the full cart and total back to the caller and get explicit
  confirmation ("so that's ... for a total of $X, shall I place the order?").
- Try to get a phone or email for the confirmation before placing the order, and call
  record_contact_info once you have it.
- Keep responses short and conversational -- this is spoken aloud, not read.
- If the caller wants to end the call, confirm and call end_call.
`.trim();

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