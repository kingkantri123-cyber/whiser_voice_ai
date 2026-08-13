// Drives the text-agent core through a full order with no audio involved --
// this is the "automated scripted conversation" test the assignment calls
// out as a stretch item. Run with: npm run test:conversation
// Requires GEMINI_API_KEY to be set (real model calls, not mocked).

import "dotenv/config";
import { sessionStore } from "../sessionStore.js";
import { runTurn } from "../agent.js";

const script = [
  "Hi, can I see the menu?",
  "I'll get a lunch combo.",
  "The burrito, with a side of fries, and a cola to drink.",
  "That's it, what's my total?",
  "Yes place the order, my number is 555-0100.",
];

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set -- add it to .env before running this script.");
    process.exit(1);
  }

  const sessionId = "scripted-test-" + Date.now();
  const session = sessionStore.create(sessionId);

  const allToolCalls = [];

  for (const [i, userText] of script.entries()) {
    console.log(`\n--- turn ${i + 1} ---`);
    console.log(`caller: ${userText}`);
    const result = await runTurn(session, userText);
    console.log(`agent:  ${result.reply}`);
    if (result.toolCalls.length) {
      console.log(
        `tools:  ${result.toolCalls.map((t) => t.name).join(", ")}`
      );
    }
    allToolCalls.push(...result.toolCalls.map((t) => t.name));
  }

  console.log("\n--- assertions ---");
  assert(allToolCalls.includes("list_menu"), "agent listed the menu via a tool, not from memory");
  assert(allToolCalls.includes("add_to_cart"), "agent added an item to the cart");
  assert(
    session.cart.lines.length > 0,
    "cart has at least one line item"
  );
  assert(
    session.cart.lines[0].chosen.some((c) => c.nested.length > 0),
    "the nested combo modifier (entrée -> side) was captured"
  );
  assert(allToolCalls.includes("place_order"), "agent called place_order");
  assert(session.cart.placed === true, "cart is marked placed");
  assert(session.cart.total() > 0, "order total is non-zero");

  console.log("\nAll assertions passed.");
  console.log("\nFinal cart:", JSON.stringify(session.cart.view(), null, 2));
}

main().catch((err) => {
  console.error("\nScripted conversation FAILED:", err.message);
  process.exit(1);
});
