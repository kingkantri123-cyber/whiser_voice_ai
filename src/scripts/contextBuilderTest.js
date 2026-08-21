import assert from "node:assert/strict";
import { buildLLMContext } from "../contextBuilder.js";

function makeSession(messages) {
  return {
    history: messages,
    contextSummary: "",
    contextSummaryMessageCount: 1,
    contextDebug: null,
    usageMonitor: null,
  };
}

const system = { role: "system", content: "Restaurant assistant" };

const shortSession = makeSession([
  system,
  { role: "user", content: "I want a pizza." },
  { role: "assistant", content: "What size?" },
  { role: "user", content: "Medium." },
]);
const shortContext = await buildLLMContext(shortSession, 3);
assert.equal(shortSession.contextSummary, "");
assert.equal(shortContext.messages.at(-1).content, "Medium.");

const longHistory = [system];
for (let index = 0; index < 9; index += 1) {
  longHistory.push({ role: "user", content: `Order detail ${index} ${"important ".repeat(120)}` });
  longHistory.push({ role: "assistant", content: `Acknowledged ${index}` });
}
const activeStart = longHistory.length;
longHistory.push({ role: "user", content: "What is my current order?" });
const longSession = makeSession(longHistory);
let summaryCalled = false;
const longContext = await buildLLMContext(longSession, activeStart, {
  summarize: async () => {
    summaryCalled = true;
    return "The user has an order with previously discussed details.";
  },
});
assert.equal(summaryCalled, true);
assert.match(longContext.messages[1].content, /Conversation summary/);
assert.equal(longContext.messages.at(-1).content, "What is my current order?");
assert.ok(longContext.debug.olderMessagesSummarized > 0);

const toolHistory = [
  system,
  { role: "user", content: "Show the menu." },
  { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "list_menu", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call_1", content: JSON.stringify({ categories: [{ name: "Pizza", items: [{ name: "Margherita Pizza", description: "Basil" }] }] }) },
];
const toolSession = makeSession(toolHistory);
const toolContext = await buildLLMContext(toolSession, 1);
assert.equal(toolContext.messages.filter((message) => message.role === "assistant").length, 1);
assert.equal(toolContext.messages.filter((message) => message.role === "tool").length, 1);
assert.ok(toolContext.debug.toolMessagesIncluded >= 1);

const activeToolSession = makeSession([
  system,
  { role: "user", content: "Add an item." },
  { role: "assistant", tool_calls: [{ id: "call_2", type: "function", function: { name: "get_item_details", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call_2", content: JSON.stringify({ item: { id: "pizza", name: "Margherita Pizza", description: "Basil", basePrice: 12, unnecessaryPayload: "x".repeat(1000) } }) },
]);
const activeToolContext = await buildLLMContext(activeToolSession, 1);
const activeToolResult = activeToolContext.messages.find((message) => message.role === "tool").content;
assert.ok(activeToolResult.length < 500);
assert.match(activeToolResult, /optionGroups/);
assert.doesNotMatch(activeToolResult, /unnecessaryPayload/);

console.log("contextBuilderTest: passed");