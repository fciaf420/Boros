import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import Database from "better-sqlite3";

const ROOT = path.resolve(import.meta.dirname, "..");
loadEnv({ path: path.join(ROOT, ".env") });

const app = express();
app.use(cors({ origin: [/^https?:\/\/localhost(:\d+)?$/] }));
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

// ---------- On-chain account data via Boros API ----------

/** Convert a base-18 wei string (e.g. "77501328865054030296") to a float (≈77.50) */
function fromBase18(s: string | undefined | null): number {
  if (!s || s === "0") return 0;
  try {
    return Number(BigInt(s)) / 1e18;
  } catch {
    return 0;
  }
}

app.get("/api/account", async (_req, res) => {
  const userAddress = process.env.BOROS_ROOT_ADDRESS;
  const accountId = process.env.BOROS_ACCOUNT_ID;
  if (!userAddress || !accountId) {
    return res.json({ error: "BOROS_ROOT_ADDRESS / BOROS_ACCOUNT_ID not configured" });
  }
  try {
    const raw = (await borosFetch(
      `/v1/collaterals/summary?userAddress=${userAddress}&accountId=${accountId}`
    )) as { collaterals?: Array<Record<string, unknown>> };

    const collaterals = raw.collaterals ?? [];
    let equity = 0;
    let availableBalance = 0;
    let initialMarginUsed = 0;
    let startDayEquity = 0;
    const breakdown: Array<{
      tokenId: number;
      netBalance: number;
      availableBalance: number;
      initialMargin: number;
    }> = [];

    for (const c of collaterals) {
      const cross = c.crossPosition as Record<string, unknown> | undefined;
      const totalNet = fromBase18(c.totalNetBalance as string);
      const startDay = fromBase18(c.startDayNetBalance as string);
      const crossNet = cross ? fromBase18(cross.netBalance as string) : 0;
      const crossAvail = cross ? fromBase18(cross.availableBalance as string) : 0;
      const crossMargin = cross ? fromBase18(cross.initialMargin as string) : 0;

      equity += totalNet;
      startDayEquity += startDay;
      availableBalance += crossAvail;
      initialMarginUsed += crossMargin;

      if (totalNet !== 0 || crossNet !== 0) {
        breakdown.push({
          tokenId: c.tokenId as number,
          netBalance: crossNet || totalNet,
          availableBalance: crossAvail,
          initialMargin: crossMargin,
        });
      }
    }

    res.json({ equity, availableBalance, initialMarginUsed, startDayEquity, collateralBreakdown: breakdown });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get("/api/account/positions", async (_req, res) => {
  const userAddress = process.env.BOROS_ROOT_ADDRESS;
  const accountId = process.env.BOROS_ACCOUNT_ID;
  if (!userAddress || !accountId) {
    return res.json({ positions: [], error: "BOROS_ROOT_ADDRESS / BOROS_ACCOUNT_ID not configured" });
  }
  try {
    const raw = (await borosFetch(
      `/v1/collaterals/summary?userAddress=${userAddress}&accountId=${accountId}`
    )) as {
      collaterals?: Array<{
        tokenId: number;
        crossPosition?: {
          marketPositions?: Array<Record<string, unknown>>;
          netBalance?: string;
        };
        isolatedPositions?: Array<{
          marketPositions?: Array<Record<string, unknown>>;
        }>;
      }>;
    };

    const positions: Array<{
      marketId: number;
      tokenId: number;
      side: string;
      sizeBase: number;
      notionalUsd: number;
      fixedApr: number;
      markApr: number;
      liquidationApr: number | null;
      initialMarginUsd: number;
      marginType: string;
      unrealizedPnl: number;
      liquidationBufferBps: number | null;
    }> = [];

    for (const c of raw.collaterals ?? []) {
      // Cross positions
      for (const mp of c.crossPosition?.marketPositions ?? []) {
        const signedSize = mp.notionalSize !== undefined ? BigInt(String(mp.notionalSize)) : 0n;
        const absSize = signedSize < 0n ? -signedSize : signedSize;
        if (absSize === 0n) continue;
        const fixedApr = Number(mp.fixedApr ?? 0);
        const markApr = Number(mp.markApr ?? 0);
        const isLong = signedSize >= 0n;
        const notional = fromBase18(String(absSize));
        // Unrealized PnL: use API field if present, else approximate from APR delta
        const rawPnl = mp.unrealizedPnl !== undefined ? fromBase18(String(mp.unrealizedPnl)) : null;
        const unrealizedPnl = rawPnl ?? (isLong ? (markApr - fixedApr) : (fixedApr - markApr)) * notional;
        // Liquidation buffer in bps
        const liqApr = mp.liquidationApr !== undefined ? Number(mp.liquidationApr) : null;
        const liquidationBufferBps = liqApr != null
          ? Math.abs(markApr - liqApr) * 10000
          : null;
        positions.push({
          marketId: Number(mp.marketId ?? 0),
          tokenId: c.tokenId,
          side: isLong ? "LONG" : "SHORT",
          sizeBase: Number(absSize) / 1e18,
          notionalUsd: notional,
          fixedApr,
          markApr,
          liquidationApr: liqApr,
          initialMarginUsd: fromBase18(mp.initialMargin as string),
          marginType: "cross",
          unrealizedPnl,
          liquidationBufferBps,
        });
      }
      // Isolated positions
      for (const iso of c.isolatedPositions ?? []) {
        for (const mp of iso.marketPositions ?? []) {
          const signedSize = mp.notionalSize !== undefined ? BigInt(String(mp.notionalSize)) : 0n;
          const absSize = signedSize < 0n ? -signedSize : signedSize;
          if (absSize === 0n) continue;
          const fixedApr = Number(mp.fixedApr ?? 0);
          const markApr = Number(mp.markApr ?? 0);
          const isLong = signedSize >= 0n;
          const notional = fromBase18(String(absSize));
          const rawPnl = mp.unrealizedPnl !== undefined ? fromBase18(String(mp.unrealizedPnl)) : null;
          const unrealizedPnl = rawPnl ?? (isLong ? (markApr - fixedApr) : (fixedApr - markApr)) * notional;
          const liqApr = mp.liquidationApr !== undefined ? Number(mp.liquidationApr) : null;
          const liquidationBufferBps = liqApr != null
            ? Math.abs(markApr - liqApr) * 10000
            : null;
          positions.push({
            marketId: Number(mp.marketId ?? 0),
            tokenId: c.tokenId,
            side: isLong ? "LONG" : "SHORT",
            sizeBase: Number(absSize) / 1e18,
            notionalUsd: notional,
            fixedApr,
            markApr,
            liquidationApr: liqApr,
            initialMarginUsd: fromBase18(mp.initialMargin as string),
            marginType: "isolated",
            unrealizedPnl,
            liquidationBufferBps,
          });
        }
      }
    }

    res.json({ positions });
  } catch (err) {
    res.status(502).json({ positions: [], error: String(err) });
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

// ---------- Copy trade endpoints ----------

app.get("/api/copy-positions", (_req, res) => {
  const store = getDb();
  if (!store) return res.json([]);
  try {
    const rows = store.prepare("SELECT * FROM copy_positions WHERE status = 'OPEN' ORDER BY opened_at ASC").all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/copy-trades", (_req, res) => {
  const store = getDb();
  if (!store) return res.json([]);
  try {
    const rows = store.prepare("SELECT * FROM copy_trade_records ORDER BY recorded_at DESC LIMIT 50").all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/copy-targets", (_req, res) => {
  const store = getDb();
  if (!store) return res.json([]);
  try {
    const rows = store.prepare("SELECT * FROM copy_target_snapshots ORDER BY recorded_at DESC LIMIT 1").all();
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
      if (latest && latest.reason && !(latest.reason as string).toLowerCase().includes("resolved")) {
        killSwitchActive = true;
      }
    } catch { /* empty */ }
  }

  res.json({
    mode: process.env.BOROS_MODE ?? "paper",
    copyTradeEnabled: process.env.BOROS_COPY_TRADE_ENABLED === "true",
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

const server = app.listen(PORT, () => {
  console.log(`[boros-ui] API server running on http://localhost:${PORT}`);
  console.log(`[boros-ui] Boros API: ${BOROS_API}`);
  console.log(`[boros-ui] SQLite: ${SQLITE_PATH}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[boros-ui] Port ${PORT} already in use. Set UI_PORT in .env to use a different port.`);
  } else {
    console.error(`[boros-ui] Server error: ${err.message}`);
  }
  process.exit(1);
});
