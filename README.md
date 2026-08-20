# Voice Ordering Agent — MVP (tool-calling core, text only)

This is stage 1 of the build plan: a working ordering agent you talk to over
plain text/HTTP, with real tool-calling, a comprehensive menu with nested
modifiers, per-session carts, and server-side validation so the model can
never invent an item or a price. Voice (LiveKit + STT/TTS) gets layered on
top of this in stage 2 without changing anything in here.

## Setup

```bash
npm install
cp .env.example .env
# put your free Gemini key in .env -- get one at https://aistudio.google.com/apikey
npm start
```

Voice responses use Canopy Orpheus through Groq first, then fall back to
Deepgram Aura if Canopy fails. Set `DEEPGRAM_API_KEY` in `.env` to enable the
fallback.

Server runs on `http://localhost:3000`.

## Try it

```bash
# 1. start a session
curl -s -X POST http://localhost:3000/api/session | tee /tmp/session.json
# -> {"sessionId": "abc123..."}

# 2. talk to it (reuse the sessionId for every turn)
curl -s -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "abc123...", "message": "Hi, what pizzas do you have?"}' | jq

curl -s -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "abc123...", "message": "I will take a medium pepperoni pizza, thin crust"}' | jq

# 3. check the cart directly
curl -s http://localhost:3000/api/cart/abc123... | jq

# 4. see placed orders (Orders page data)
curl -s http://localhost:3000/api/orders | jq

# 5. per-session metrics (analytics view: turns, tokens, latency)
curl -s http://localhost:3000/api/analytics/abc123... | jq
```

## Automated scripted conversation (the test)

```bash
npm run test:conversation
```

Drives a full order through the combo item (which exercises the nested
required choice: entrée → that entrée's own required side) and asserts:
the agent used `list_menu` rather than recalling items from memory, the
nested modifier was actually captured, `place_order` fired, and the cart
ends up in a placed state with a non-zero total.

## What's deliberately not here yet

- Voice transport (LiveKit), STT/TTS — this is the text core they sit on top of.
- SMS/email confirmation tool (`send_order_confirmation`) — stubbed out of
  scope for the MVP; `record_contact_info` and `place_order` already give
  it everything it'll need.
- Frontend — this is API-only for now, meant to be curl/Postman-tested.

## Key design decisions

- **Menu is data, not prompt text.** `src/data/menu.js` is the only source
  of truth; every tool reads from it directly, so it's structurally
  impossible for the model to state a price it wasn't given by a tool call.
- **All validation is server-side.** `src/cart.js` enforces required
  option groups (including nested ones) and computes every price — the
  model's arithmetic and claims are never trusted.
- **One cart per session.** `src/sessionStore.js` keys everything off a
  `sessionId` the client generates once per call; two callers never share
  state.
- **Gemini free tier** (`gemini-2.5-flash`) does the tool-calling — no
  billing required to run or evaluate this.
