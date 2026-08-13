import { Cart } from "./cart.js";

/**
 * One session per call. Never share a cart across sessions.
 * In-memory Map is fine for a POC; swap for Redis if you need
 * multi-process/restart durability later.
 */
class SessionStore {
  constructor() {
    this.sessions = new Map();
  }

  create(sessionId) {
    const session = {
      id: sessionId,
      cart: new Cart(),
      history: [], // Gemini "contents" array (role: user/model, parts)
      contact: null, // { name?, phone?, email? } once caller provides it
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "active", // active | ended | abandoned
      metrics: {
        turns: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        turnLatenciesMs: [],
      },
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getOrCreate(sessionId) {
    return this.get(sessionId) || this.create(sessionId);
  }

  end(sessionId, status = "ended") {
    const session = this.get(sessionId);
    if (!session) return null;
    session.status = status;
    session.endedAt = new Date().toISOString();
    return session;
  }

  all() {
    return Array.from(this.sessions.values());
  }
}

export const sessionStore = new SessionStore();
