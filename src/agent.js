import Groq from "groq-sdk";
import { toolDeclarations, executeTool, CHECKOUT_TOOL_NAMES } from "./tools.js";
import { elapsedMs, startTimer } from "./usageMonitor.js";
import { buildLLMContext, estimateTokens } from "./contextBuilder.js";
import { createHash, randomUUID } from "node:crypto";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const MAX_TOOL_ROUNDS = 6; // guard against a runaway tool-calling loop
// gpt-oss-120b on Groq supports reasoning_effort. Tool-selection rounds only
// need to pick a function + arguments, not produce customer-facing prose, so
// they're run at low effort. Set to null to disable and use the API default
// on every round.
// Opt-in: this trades off some reasoning quality on tool-selection rounds
// for latency, so it's off (null) by default. Set env TOOL_ROUND_REASONING_EFFORT=low
// to try it -- watch reply quality on complex multi-option orders before
// keeping it on.
const TOOL_ROUND_REASONING_EFFORT = process.env.TOOL_ROUND_REASONING_EFFORT || null;

const SYSTEM_INSTRUCTION = `
You are a friendly, efficient phone agent for a restaurant. You take orders over what
the caller experiences as a phone call.

Hard rules:
- NEVER state a menu item, price, or option that didn't come back from a tool call.
  If you don't already have it from a tool result in this conversation, call the
  relevant tool first.
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

// Cart-management/checkout tools (update, remove, place_order,
// record_contact_info) only make sense once the cart has a line in it.
// Withholding their schema during the item-selection phase of a call --
// which is most of a typical order -- shrinks the tools payload sent on
// every single LLM request, not just once per turn.
function cartHasItems(session) {
  try {
    const view = session.cart?.view?.();
    return Array.isArray(view?.lines) && view.lines.length > 0;
  } catch {
    return true; // fail open: never hide tools if cart state can't be read
  }
}

function toGroqTools(session) {
  const includeCheckout = cartHasItems(session);
  const decls = includeCheckout
    ? toolDeclarations
    : toolDeclarations.filter((decl) => !CHECKOUT_TOOL_NAMES.includes(decl.name));
  return decls.map((decl) => ({
    type: "function",
    function: {
      name: decl.name,
      description: decl.description,
      parameters: decl.parameters,
    },
  }));
}

function argumentsFingerprint(args) {
  return createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16);
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
  const turnStartIndex = session.history.length - 1;
  const turnId = randomUUID();
  session.usageMonitor?.beginTurn(turnId);
  let inputTokens = 0;
  let outputTokens = 0;
  const startedAt = Date.now();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const requestStartedAt = startTimer();
    // Recomputed every round (not hoisted) because a tool call earlier in
    // this same turn -- e.g. the caller's first add_to_cart -- can change
    // which tools are relevant for the next round.
    const toolsPayload = toGroqTools(session);
    const toolSchemaTokens = estimateTokens(JSON.stringify(toolsPayload));
    const context = await buildLLMContext(session, turnStartIndex, { toolSchemaTokens });
    let response;
    try {
      response = await groq.chat.completions.create({
        model: MODEL,
        messages: context.messages,
        tools: toolsPayload,
        tool_choice: "auto",
        ...(round > 0 && TOOL_ROUND_REASONING_EFFORT
          ? { reasoning_effort: TOOL_ROUND_REASONING_EFFORT }
          : {}),
      });
      session.usageMonitor?.recordLlm({
        model: MODEL,
        usage: response.usage,
        latency: elapsedMs(requestStartedAt),
        status: "success",
        response,
        context: context.debug.context,
        toolRound: round,
      });
    } catch (error) {
      session.usageMonitor?.recordLlm({
        model: activeModel,
        latency: elapsedMs(requestStartedAt),
        status: "failure",
        error,
        context: context.debug.context,
        toolRound: round,
      });
      session.usageMonitor?.endTurn();
      throw error;
    }

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
      session.metrics.totalTokens = session.metrics.totalInputTokens + session.metrics.totalOutputTokens;
      session.metrics.model = MODEL;
      session.metrics.context = session.contextDebug;
      session.metrics.turnLatenciesMs.push(elapsedMs);
      session.usageMonitor?.endTurn();

      return {
        reply: text,
        toolCalls: toolCallLog,
        cart: session.cart.view(),
        metrics: {
          elapsedMs,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          model: MODEL,
          context: session.contextDebug,
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
      toolCallLog.push({ name: call.function.name, args, result });
      session.usageMonitor?.recordToolCall({
        round,
        toolName: call.function.name,
        argumentsFingerprint: argumentsFingerprint(args),
      });
      session.history.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });

      if (call.function.name === "end_call" && session.status === "ended") {
        const elapsedMs = Date.now() - startedAt;
        session.metrics.turns += 1;
        session.metrics.totalInputTokens += inputTokens;
        session.metrics.totalOutputTokens += outputTokens;
        session.metrics.totalTokens = session.metrics.totalInputTokens + session.metrics.totalOutputTokens;
        session.metrics.model = activeModel;
        session.metrics.context = session.contextDebug;
        session.metrics.turnLatenciesMs.push(elapsedMs);
        session.usageMonitor?.endTurn();
        return {
          reply: "Thanks for calling. Goodbye.",
          toolCalls: toolCallLog,
          cart: session.cart.view(),
          metrics: {
            elapsedMs,
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            model: activeModel,
            context: session.contextDebug,
          },
          sessionStatus: session.status,
        };
      }
    }
  }

  // Safety valve: too many tool rounds without a final text reply.
  session.metrics.turns += 1;
  session.metrics.totalInputTokens += inputTokens;
  session.metrics.totalOutputTokens += outputTokens;
  session.metrics.totalTokens = session.metrics.totalInputTokens + session.metrics.totalOutputTokens;
  session.metrics.model = MODEL;
  session.metrics.context = session.contextDebug;
  session.usageMonitor?.endTurn();
  return {
    reply:
      "Sorry, I'm having trouble completing that -- could you repeat what you'd like?",
    toolCalls: toolCallLog,
    cart: session.cart.view(),
    metrics: {
      elapsedMs: Date.now() - startedAt,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      model: MODEL,
      context: session.contextDebug,
    },
    sessionStatus: session.status,
    warning: "MAX_TOOL_ROUNDS exceeded",
  };
}