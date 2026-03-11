import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import Database from "better-sqlite3";

const ROOT = path.resolve(import.meta.dirname, "..");
loadEnv({ path: path.join(ROOT, ".env") });

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.UI_PORT ?? 3142);
const BOROS_API = process.env.BOROS_API_BASE_URL ?? "https://api.boros.finance/core";
const SQLITE_PATH = process.env.BOROS_SQLITE_PATH
  ? path.resolve(ROOT, process.env.BOROS_SQLITE_PATH)
  : path.join(ROOT, "data", "boros_trader.sqlite");

// ---------- SQLite (read-only) ----------

let db: Database.Database | null = null;
function getDb(): Database.Database | null {
  if (db) return db;
  if (!fs.existsSync(SQLITE_PATH)) return null;
  try {
    db = new Database(SQLITE_PATH, { readonly: true });
    db.pragma("journal_mode = WAL");
    return db;
  } catch {
    return null;
  }
}

// ---------- Boros API proxy ----------

async function borosFetch(pathname: string): Promise<unknown> {
  const res = await fetch(`${BOROS_API}${pathname}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Boros API ${res.status}: ${res.statusText}`);
  return res.json();
}

app.get("/api/markets", async (_req, res) => {
  try {
    const data = await borosFetch("/v1/markets?limit=100&isWhitelisted=true");
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get("/api/orderbook/:id", async (req, res) => {
  try {
    const data = await borosFetch(`/v1/order-books/${req.params.id}?tickSize=0.001`);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get("/api/indicators/:id", async (req, res) => {
  try {
    const data = await borosFetch(
      `/v2/markets/indicators?marketId=${req.params.id}&timeFrame=1h&select=u,fp,udma:7;30`
    );
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ---------- SQLite endpoints ----------

app.get("/api/positions", (_req, res) => {
  const store = getDb();
  if (!store) return res.json([]);
  try {
    const rows = store.prepare("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY opened_at ASC").all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/orders", (_req, res) => {
  const store = getDb();
  if (!store) return res.json([]);
  try {
    const rows = store.prepare("SELECT * FROM orders ORDER BY recorded_at DESC LIMIT 50").all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/signals", (_req, res) => {
  const store = getDb();
  if (!store) return res.json([]);
  try {
    const rows = store.prepare("SELECT * FROM signals ORDER BY recorded_at DESC LIMIT 50").all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/kill-events", (_req, res) => {
  const store = getDb();
  if (!store) return res.json([]);
  try {
    const rows = store.prepare("SELECT * FROM kill_switch_events ORDER BY recorded_at DESC LIMIT 20").all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------- JSON file endpoints ----------

app.get("/api/rates", (_req, res) => {
  const ratesPath = path.join(ROOT, "rates.json");
  if (!fs.existsSync(ratesPath)) return res.json({ markets: [] });
  try {
    const raw = fs.readFileSync(ratesPath, "utf-8");
    res.json(JSON.parse(raw));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/state", (_req, res) => {
  const statePath = path.join(ROOT, "positions_state.json");
  let strategyState: Record<string, string> = {};
  try {
    strategyState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch { /* empty */ }

  let runtimeState: Record<string, unknown> = {};
  const store = getDb();
  if (store) {
    try {
      const rows = store.prepare("SELECT key, value FROM runtime_state").all() as Array<{ key: string; value: string }>;
      for (const row of rows) {
        try { runtimeState[row.key] = JSON.parse(row.value); } catch { runtimeState[row.key] = row.value; }
      }
    } catch { /* empty */ }
  }

  let killSwitchActive = false;
  if (store) {
    try {
      const latest = store.prepare("SELECT * FROM kill_switch_events ORDER BY recorded_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
      if (latest) killSwitchActive = true;
    } catch { /* empty */ }
  }

  res.json({
    mode: process.env.BOROS_MODE ?? "paper",
    strategyState,
    runtimeState,
    killSwitchActive,
  });
});

// ---------- ENV settings ----------

const SENSITIVE_KEYS = new Set([
  "BOROS_PRIVATE_KEY",
  "BOROS_RPC_URL",
  "BOROS_ROOT_ADDRESS",
  "BOROS_ACCOUNT_ID",
  "TG_API_ID",
  "TG_API_HASH",
  "TG_PHONE",
  "ALERT_BOT_TOKEN",
  "ALERT_CHAT_ID",
  "BOROS_COPY_TRADE_TARGET_ADDRESS",
  "BOROS_COPY_TRADE_TARGET_ACCOUNT_ID",
  "BOROS_COPY_TRADE_DISCORD_WEBHOOK_URL",
  "DISCORD_WEBHOOK_URL",
]);

const EDITABLE_PREFIXES = ["BOROS_"];

function readEnvFile(): string {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return "";
  return fs.readFileSync(envPath, "utf-8");
}

function parseEnvVars(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    result[key] = val;
  }
  return result;
}

app.get("/api/settings", (_req, res) => {
  const raw = readEnvFile();
  const vars = parseEnvVars(raw);
  const filtered: Record<string, string> = {};
  for (const [key, val] of Object.entries(vars)) {
    if (!SENSITIVE_KEYS.has(key)) {
      filtered[key] = val;
    }
  }
  res.json(filtered);
});

app.post("/api/settings", (req, res) => {
  const updates = req.body as Record<string, string>;
  if (!updates || typeof updates !== "object") {
    return res.status(400).json({ error: "Expected JSON object" });
  }

  // Validate keys
  for (const key of Object.keys(updates)) {
    if (SENSITIVE_KEYS.has(key)) {
      return res.status(403).json({ error: `Cannot modify sensitive key: ${key}` });
    }
    if (!EDITABLE_PREFIXES.some((p) => key.startsWith(p))) {
      return res.status(403).json({ error: `Key not editable: ${key}` });
    }
  }

  // Read existing file, update values, preserve comments and order
  const envPath = path.join(ROOT, ".env");
  let raw = "";
  if (fs.existsSync(envPath)) {
    raw = fs.readFileSync(envPath, "utf-8");
  }

  const lines = raw.split("\n");
  const updatedKeys = new Set<string>();

  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in updates) {
      updatedKeys.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  // Append any new keys not already in file
  for (const [key, val] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      newLines.push(`${key}=${val}`);
    }
  }

  fs.writeFileSync(envPath, newLines.join("\n"), "utf-8");
  res.json({ ok: true, message: "Settings saved. Restart trader for changes to take effect." });
});

// ---------- Start ----------

app.listen(PORT, () => {
  console.log(`[boros-ui] API server running on http://localhost:${PORT}`);
  console.log(`[boros-ui] Boros API: ${BOROS_API}`);
  console.log(`[boros-ui] SQLite: ${SQLITE_PATH}`);
});
