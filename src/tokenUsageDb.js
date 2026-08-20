import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "data", "token-usage.json");

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ calls: [] }, null, 2), "utf8");
  }
}

function readDb() {
  ensureDb();
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return { calls: [] };
  }
}

function writeDb(db) {
  ensureDb();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

export function saveCallUsage(session) {
  const db = readDb();
  const existing = db.calls.find((call) => call.sessionId === session.id);
  if (existing) return existing;

  const record = {
    sessionId: session.id,
    startedAt: session.startedAt,
    endedAt: session.endedAt || new Date().toISOString(),
    status: session.status,
    usage: {
      metrics: session.metrics,
      ...session.usageMonitor.toJSON(),
    },
    savedAt: new Date().toISOString(),
  };

  db.calls.push(record);
  writeDb(db);
  console.log(`[db] Token usage saved -> sessionId=${session.id}`);
  return record;
}

export function getAllCallUsage() {
  return readDb().calls;
}
