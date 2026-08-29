import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USAGE_PATH = path.join(__dirname, "data", "usage.json");

function ensureDb() {
  const dir = path.dirname(USAGE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(USAGE_PATH)) fs.writeFileSync(USAGE_PATH, JSON.stringify({ records: [] }, null, 2), "utf8");
}

function readDb() {
  ensureDb();
  try {
    return JSON.parse(fs.readFileSync(USAGE_PATH, "utf8"));
  } catch {
    return { records: [] };
  }
}

function writeDb(db) {
  ensureDb();
  fs.writeFileSync(USAGE_PATH, JSON.stringify(db, null, 2), "utf8");
}

/**
 * Appends one per-turn usage record (one /api/voice-chat call = one turn).
 * A session (one call from greeting to hangup) spans multiple records
 * sharing the same sessionId.
 */
export function recordUsage(entry) {
  const db = readDb();
  const record = { id: nanoid(10), timestamp: new Date().toISOString(), ...entry };
  db.records.push(record);
  writeDb(db);
  return record;
}

export function getAllUsage() {
  return readDb().records;
}
