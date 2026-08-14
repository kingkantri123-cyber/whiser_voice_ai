import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "data", "orders.json");

/**
 * Ensures the data directory and orders.json file exist.
 */
function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ orders: [] }, null, 2), "utf8");
}

/**
 * Reads and parses the orders database.
 * @returns {{ orders: object[] }}
 */
function readDb() {
  ensureDb();
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return { orders: [] };
  }
}

/**
 * Writes the database object back to disk.
 * @param {{ orders: object[] }} db
 */
function writeDb(db) {
  ensureDb();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

/**
 * Saves a completed order to the JSON database.
 * Skips saving if the order was already recorded (idempotent by sessionId).
 *
 * @param {object} session  - The session object from SessionStore.
 * @returns {object}        - The saved order record.
 */
export function saveOrder(session) {
  const db = readDb();

  // Idempotency: don't double-save the same session
  if (db.orders.find((o) => o.sessionId === session.id)) {
    return db.orders.find((o) => o.sessionId === session.id);
  }

  const order = {
    sessionId: session.id,
    savedAt: new Date().toISOString(),
    startedAt: session.startedAt,
    endedAt: session.endedAt || new Date().toISOString(),
    status: session.status,
    contact: session.contact || null,
    cart: {
      lines: session.cart.lines,
      total: session.cart.total(),
      placedAt: session.cart.placedAt,
    },
    metrics: session.metrics,
  };

  db.orders.push(order);
  writeDb(db);

  console.log(`[db] Order saved → sessionId=${session.id}, total=$${order.cart.total}`);
  return order;
}

/**
 * Returns all saved orders.
 * @returns {object[]}
 */
export function getAllOrders() {
  return readDb().orders;
}

/**
 * Returns a single order by sessionId.
 * @param {string} sessionId
 * @returns {object|null}
 */
export function getOrder(sessionId) {
  return readDb().orders.find((o) => o.sessionId === sessionId) || null;
}
