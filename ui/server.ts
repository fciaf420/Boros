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
    const TICK_SIZE = 0.001; // APR per tick
    const raw = (await borosFetch(`/v1/order-books/${req.params.id}?tickSize=${TICK_SIZE}`)) as {
      long?: { ia: number[]; sz: string[] };
      short?: { ia: number[]; sz: string[] };
    };
    const fromBase18 = (s: string) => Number(BigInt(s)) / 1e18;
    const toEntries = (side: { ia: number[]; sz: string[] } | undefined) =>
      (side?.ia ?? []).map((tick, i) => ({
        apr: tick * TICK_SIZE,
        notional: fromBase18(side!.sz[i]),
      }));
    // long side = bids (highest first), short side = asks (lowest first)
    const bids = toEntries(raw.long).sort((a, b) => b.apr - a.apr);
    const asks = toEntries(raw.short).sort((a, b) => a.apr - b.apr);
    res.json({ bids, asks });
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

/** Build a tokenId → USD price map from the assets API. */
async function getTokenPrices(): Promise<Map<number, number>> {
  const assets = await getAssets();
  const map = new Map<number, number>();
  for (const a of assets) {
    const id = a.tokenId as number;
    const price = Number(a.usdPrice ?? 0);
    if (id > 0 && price > 0) map.set(id, price);
  }
  return map;
}

app.get("/api/account", async (_req, res) => {
  const userAddress = process.env.BOROS_ROOT_ADDRESS;
  const accountId = process.env.BOROS_ACCOUNT_ID;
  if (!userAddress || !accountId) {
    return res.json({ error: "BOROS_ROOT_ADDRESS / BOROS_ACCOUNT_ID not configured" });
  }
  try {
    const [rawResp, prices] = await Promise.all([
      borosFetch(`/v1/collaterals/summary?userAddress=${userAddress}&accountId=${accountId}`),
      getTokenPrices(),
    ]);
    const raw = rawResp as { collaterals?: Array<Record<string, unknown>> };

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
      const tokenId = c.tokenId as number;
      const price = prices.get(tokenId) ?? 1;
      const cross = c.crossPosition as Record<string, unknown> | undefined;
      const totalNet = fromBase18(c.totalNetBalance as string) * price;
      const startDay = fromBase18(c.startDayNetBalance as string) * price;
      const crossNet = cross ? fromBase18(cross.netBalance as string) * price : 0;
      const crossAvail = cross ? fromBase18(cross.availableBalance as string) * price : 0;
      const crossMargin = cross ? fromBase18(cross.initialMargin as string) * price : 0;

      equity += totalNet;
      startDayEquity += startDay;
      availableBalance += crossAvail;
      initialMarginUsed += crossMargin;

      if (totalNet !== 0 || crossNet !== 0) {
        breakdown.push({
          tokenId,
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

// Shared position extraction from collaterals response
interface ExtractedPosition {
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
  allTimePnl: number;
  settledPct: number;
}

function parseMarketPosition(mp: Record<string, unknown>, tokenId: number, marginType: string, tokenPrice: number): ExtractedPosition | null {
  const signedSize = mp.notionalSize !== undefined ? BigInt(String(mp.notionalSize)) : 0n;
  const absSize = signedSize < 0n ? -signedSize : signedSize;
  if (absSize === 0n) return null;
  const fixedApr = Number(mp.fixedApr ?? 0);
  const markApr = Number(mp.markApr ?? 0);
  const isLong = signedSize >= 0n;
  const notionalToken = fromBase18(String(absSize));
  const notionalUsd = notionalToken * tokenPrice;
  const marginToken = fromBase18(mp.initialMargin as string);
  const marginUsd = marginToken * tokenPrice;
  // PnL: use pnl.unrealisedPnl (British spelling) if available, else estimate from APR spread
  const pnl = mp.pnl as Record<string, unknown> | undefined;
  const rawUnrealised = pnl?.unrealisedPnl ?? pnl?.unrealizedPnl;
  const unrealizedPnl = rawUnrealised != null
    ? fromBase18(String(rawUnrealised)) * tokenPrice
    : (isLong ? (markApr - fixedApr) : (fixedApr - markApr)) * notionalUsd;
  const liqApr = mp.liquidationApr !== undefined ? Number(mp.liquidationApr) : null;
  const liquidationBufferBps = liqApr != null ? Math.abs(markApr - liqApr) * 10000 : null;
  const allTimePnl = pnl ? fromBase18(String(pnl.allTimePnl ?? "0")) * tokenPrice : 0;
  const settledPct = Number(mp.settledProgressPercentage ?? 0);
  return {
    marketId: Number(mp.marketId ?? 0),
    tokenId,
    side: isLong ? "LONG" : "SHORT",
    sizeBase: notionalToken,
    notionalUsd,
    fixedApr,
    markApr,
    liquidationApr: liqApr,
    initialMarginUsd: marginUsd,
    marginType,
    unrealizedPnl,
    liquidationBufferBps,
    allTimePnl,
    settledPct,
  };
}

function extractPositions(collaterals: Array<Record<string, unknown>>, prices: Map<number, number>): ExtractedPosition[] {
  const positions: ExtractedPosition[] = [];
  for (const c of collaterals) {
    const tokenId = c.tokenId as number;
    const tokenPrice = prices.get(tokenId) ?? 1;
    const cross = c.crossPosition as Record<string, unknown> | undefined;
    for (const mp of ((cross?.marketPositions ?? []) as Array<Record<string, unknown>>)) {
      const p = parseMarketPosition(mp, tokenId, "cross", tokenPrice);
      if (p) positions.push(p);
    }
    for (const iso of ((c.isolatedPositions ?? []) as Array<Record<string, unknown>>)) {
      for (const mp of ((iso as Record<string, unknown>).marketPositions as Array<Record<string, unknown>> ?? [])) {
        const p = parseMarketPosition(mp, tokenId, "isolated", tokenPrice);
        if (p) positions.push(p);
      }
    }
  }
  return positions;
}

app.get("/api/account/positions", async (_req, res) => {
  const userAddress = process.env.BOROS_ROOT_ADDRESS;
  const accountId = process.env.BOROS_ACCOUNT_ID;
  if (!userAddress || !accountId) {
    return res.json({ positions: [], error: "BOROS_ROOT_ADDRESS / BOROS_ACCOUNT_ID not configured" });
  }
  try {
    const [rawResp, prices] = await Promise.all([
      borosFetch(`/v1/collaterals/summary?userAddress=${userAddress}&accountId=${accountId}`),
      getTokenPrices(),
    ]);
    const raw = rawResp as { collaterals?: Array<Record<string, unknown>> };
    res.json({ positions: extractPositions(raw.collaterals ?? [], prices) });
  } catch (err) {
    res.status(502).json({ positions: [], error: String(err) });
  }
});

// ---------- Wallet lookup composite endpoint ----------

// Cache assets data (token metadata) for 5 minutes
let assetsCache: { data: Array<Record<string, unknown>>; fetchedAt: number } | null = null;
async function getAssets(): Promise<Array<Record<string, unknown>>> {
  if (assetsCache && Date.now() - assetsCache.fetchedAt < 5 * 60 * 1000) return assetsCache.data;
  const raw = (await borosFetch("/v2/assets/all")) as { assets?: Array<Record<string, unknown>> };
  assetsCache = { data: raw.assets ?? [], fetchedAt: Date.now() };
  return assetsCache.data;
}

app.get("/api/assets", async (_req, res) => {
  try {
    const assets = await getAssets();
    res.json(assets);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get("/api/wallet/:address", async (req, res) => {
  const address = req.params.address;
  if (!address || address.length !== 42 || !address.startsWith("0x")) {
    return res.status(400).json({ error: "Invalid address — must be 42 chars starting with 0x" });
  }
  try {
    const [settled, prices] = await Promise.all([
      Promise.allSettled([
        borosFetch(`/v1/collaterals/summary?userAddress=${address}&accountId=0`),
        borosFetch(`/v1/portfolios/balance-chart/all?userAddress=${address}&accountId=0&time=all`),
        borosFetch(`/v2/pnl/limit-orders?skip=0&limit=200&userAddress=${address}&accountId=0&isActive=false`),
        borosFetch(`/v1/referrals/${address}`),
      ]),
      getTokenPrices(),
    ]);
    const [collateralsR, chartR, ordersR, referralR] = settled;

    // --- Account + positions ---
    let account: Record<string, unknown> | null = null;
    let positions: ExtractedPosition[] = [];
    if (collateralsR.status === "fulfilled") {
      const raw = collateralsR.value as { collaterals?: Array<Record<string, unknown>> };
      const colls = raw.collaterals ?? [];
      let equity = 0, availableBalance = 0, initialMarginUsed = 0, startDayEquity = 0;
      for (const c of colls) {
        const tokenId = c.tokenId as number;
        const price = prices.get(tokenId) ?? 1;
        const cross = c.crossPosition as Record<string, unknown> | undefined;
        equity += fromBase18(c.totalNetBalance as string) * price;
        startDayEquity += fromBase18(c.startDayNetBalance as string) * price;
        availableBalance += cross ? fromBase18(cross.availableBalance as string) * price : 0;
        initialMarginUsed += cross ? fromBase18(cross.initialMargin as string) * price : 0;
      }
      account = { equity, availableBalance, initialMarginUsed, startDayEquity, dailyPnl: equity - startDayEquity };
      positions = extractPositions(colls, prices);
    }

    // --- Equity curve + performance ---
    // The equity curve from the balance-chart API includes deposits/withdrawals,
    // so we compute deposit-adjusted returns by detecting large jumps (>20% in one
    // data point) and treating those as external cash flows, not trading PnL.
    let equityCurve: Array<{ timestamp: number; equity: number }> = [];
    let performance: Record<string, unknown> | null = null;
    if (chartR.status === "fulfilled") {
      const raw = chartR.value as { balanceCharts?: Array<{ historicalBalances?: Array<{ t: number; u: number }> }> };
      const byTs = new Map<number, number>();
      for (const chart of raw.balanceCharts ?? []) {
        for (const pt of chart.historicalBalances ?? []) {
          byTs.set(pt.t, (byTs.get(pt.t) ?? 0) + pt.u);
        }
      }
      equityCurve = [...byTs.entries()].map(([t, eq]) => ({ timestamp: t, equity: eq })).sort((a, b) => a.timestamp - b.timestamp);
      if (equityCurve.length >= 2) {
        // Compute deposit-adjusted cumulative return using modified Dietz method:
        // For each interval, if the equity change is >20% of previous equity in a
        // single step, treat the excess as a deposit/withdrawal (not trading PnL).
        const JUMP_THRESHOLD = 0.20; // 20% single-step jump = likely deposit/withdrawal
        let cumulativeReturn = 1.0; // starts at 1x
        let peak = 1.0;
        let maxDrawdownPct = 0;

        for (let i = 1; i < equityCurve.length; i++) {
          const prev = equityCurve[i - 1].equity;
          const curr = equityCurve[i].equity;
          if (prev <= 0) continue;

          const rawChange = (curr - prev) / prev;
          // If the jump exceeds threshold, clamp the return to 0 for this step
          // (it's a deposit/withdrawal, not a trade)
          const tradingReturn = Math.abs(rawChange) > JUMP_THRESHOLD ? 0 : rawChange;
          cumulativeReturn *= (1 + tradingReturn);

          // Max drawdown on the adjusted curve
          if (cumulativeReturn > peak) peak = cumulativeReturn;
          const dd = peak > 0 ? (peak - cumulativeReturn) / peak : 0;
          if (dd > maxDrawdownPct) maxDrawdownPct = dd;
        }

        const totalReturnPct = cumulativeReturn - 1;
        const first = equityCurve[0];
        const last = equityCurve[equityCurve.length - 1];
        const periodDays = Math.max(1, (last.timestamp - first.timestamp) / 86400);
        const annualizedReturnPct = totalReturnPct / periodDays * 365;
        performance = { totalReturnPct, annualizedReturnPct, maxDrawdownPct, periodDays: Math.round(periodDays) };
      }
    }

    // --- Trading activity ---
    let tradingActivity: Record<string, unknown> | null = null;
    if (ordersR.status === "fulfilled") {
      const raw = ordersR.value as { results?: Array<{ status: number; marketId: number; placedTimestamp: number }> };
      const orders = raw.results ?? [];
      const totalOrders = orders.length;
      const filledOrders = orders.filter(o => o.status === 2).length;
      const fillRate = totalOrders > 0 ? filledOrders / totalOrders : 0;
      const days = new Set(orders.filter(o => o.placedTimestamp > 0).map(o => new Date(o.placedTimestamp * 1000).toISOString().slice(0, 10)));
      const mktCounts = new Map<number, number>();
      for (const o of orders) { mktCounts.set(o.marketId, (mktCounts.get(o.marketId) ?? 0) + 1); }
      const marketBreakdown = [...mktCounts.entries()]
        .map(([marketId, count]) => ({ marketId, count }))
        .sort((a, b) => b.count - a.count);
      tradingActivity = { totalOrders, filledOrders, fillRate, activeDays: days.size, marketBreakdown };
    }

    // --- Referral ---
    let referral: Record<string, unknown> | null = null;
    if (referralR.status === "fulfilled") {
      const raw = referralR.value as Record<string, unknown>;
      referral = {
        code: raw.referralCode ?? null,
        totalVolume: Number(raw.totalTradeVolume ?? 0),
        feeShare: Number(raw.feeSharePercentage ?? 0),
      };
    }

    res.json({ address, account, positions, equityCurve, performance, tradingActivity, referral });
  } catch (err) {
    console.error(`[wallet] lookup failed for ${req.params.address}:`, err);
    res.status(502).json({ error: `Wallet lookup failed: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// ---------- Leaderboard: on-chain wallet discovery + PnL ranking ----------

const BOROS_ROUTER = "0x8080808080daB95eFED788a9214e400ba552DEf6";
const ARB_RPC = process.env.BOROS_RPC_URL || "https://arbitrum-one-rpc.publicnode.com";
const LEADERBOARD_CACHE_PATH = path.join(ROOT, "data", "leaderboard.json");
const LEADERBOARD_MAX_AGE_MS = 6 * 60 * 60 * 1000;  // 6 hours
const LEADERBOARD_SCAN_DAYS = 30;
const RPC_BLOCK_CHUNK = 50_000;  // max blocks per eth_getLogs call on public RPCs
// Router events that embed the user address (MarketAcc) in topic[1], first 20 bytes
const TRADE_EVENT_TOPICS = new Set([
  "0x2716c297a1efedd7a9a1848499921b25fc493239b7a3d5c6cfd8c5e6552977a6",
  "0xe9a3f66f69f34044137c0ab5c69e3ee3c3ef0c3ec4e1fbc700c71e271eb59223",
  "0xd906018d619f6961a9e5364faba3fb70fbb4e769cf01e92f7264fec64b41759e",
  "0xab6651fddd82c14508b0142bfabac5136fc19398aa276795c1dbbb810db8d26d",
]);

interface LeaderboardEntry {
  address: string;
  equity: number;
  return7d: number | null;
  return30d: number | null;
  maxDrawdown: number | null;
  positionCount: number;
  totalNotional: number;
  lastActive: number;  // epoch seconds
}

interface LeaderboardCache {
  updatedAt: number;
  scanning: boolean;
  scanProgress?: string;
  entries: LeaderboardEntry[];
  walletCount: number;
  error?: string;
}

let leaderboardCache: LeaderboardCache = { updatedAt: 0, scanning: false, entries: [], walletCount: 0 };

function loadLeaderboardCache(): void {
  try {
    if (fs.existsSync(LEADERBOARD_CACHE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LEADERBOARD_CACHE_PATH, "utf-8"));
      leaderboardCache = { ...raw, scanning: false };
    }
  } catch { /* ignore */ }
}

function saveLeaderboardCache(): void {
  try {
    const dir = path.dirname(LEADERBOARD_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LEADERBOARD_CACHE_PATH, JSON.stringify(leaderboardCache));
  } catch { /* ignore */ }
}

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const resp = await fetch(ARB_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const json = (await resp.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`RPC: ${json.error.message}`);
  return json.result;
}

/** Discover unique wallets from Boros Router events via Arbitrum RPC. */
async function discoverWallets(days: number): Promise<Map<string, number>> {
  const wallets = new Map<string, number>();  // address → latest block number
  const headHex = (await rpcCall("eth_blockNumber", [])) as string;
  const head = parseInt(headHex, 16);
  // Arbitrum ~250ms blocks → ~345,600 blocks/day
  const totalBlocks = days * 345_600;
  const startBlock = Math.max(0, head - totalBlocks);

  console.log(`[leaderboard] Scanning blocks ${startBlock} to ${head} (${totalBlocks} blocks, ${days}d)`);

  // Chunk through block range
  let from = startBlock;
  let chunkNum = 0;
  const totalChunks = Math.ceil(totalBlocks / RPC_BLOCK_CHUNK);

  while (from < head) {
    const to = Math.min(from + RPC_BLOCK_CHUNK - 1, head);
    chunkNum++;

    try {
      const logs = (await rpcCall("eth_getLogs", [{
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
        address: BOROS_ROUTER,
      }])) as Array<{ topics: string[]; blockNumber: string }>;

      for (const log of logs) {
        if (log.topics.length >= 2 && TRADE_EVENT_TOPICS.has(log.topics[0])) {
          // MarketAcc: first 20 bytes of topic[1] = user root address
          const addr = "0x" + log.topics[1].slice(2, 42);
          if (addr !== "0x0000000000000000000000000000000000000000") {
            const bn = parseInt(log.blockNumber, 16);
            const existing = wallets.get(addr.toLowerCase()) ?? 0;
            if (bn > existing) wallets.set(addr.toLowerCase(), bn);
          }
        }
      }

      if (chunkNum % 20 === 0 || chunkNum === totalChunks) {
        console.log(`[leaderboard] Chunk ${chunkNum}/${totalChunks} — ${wallets.size} wallets so far`);
        leaderboardCache.scanProgress = `Scanning blocks: ${chunkNum}/${totalChunks} chunks, ${wallets.size} wallets found`;
        leaderboardCache.walletCount = wallets.size;
      }
    } catch (err) {
      console.warn(`[leaderboard] RPC error at block ${from}: ${err}`);
      // Brief pause on error, then continue
      await new Promise(r => setTimeout(r, 2000));
    }

    from = to + 1;
    // Small delay to avoid hammering the RPC
    if (chunkNum % 5 === 0) await new Promise(r => setTimeout(r, 500));
  }

  return wallets;
}

/** Fetch equity curve for a wallet and compute 7d/30d returns. Lightweight — only hits the balance chart endpoint. */
async function fetchWalletPerformance(address: string, prices: Map<number, number>): Promise<LeaderboardEntry | null> {
  try {
    const [chartResp, collResp] = await Promise.allSettled([
      borosFetch(`/v1/portfolios/balance-chart/all?userAddress=${address}&accountId=0&time=all`),
      borosFetch(`/v1/collaterals/summary?userAddress=${address}&accountId=0`),
    ]);

    // Equity curve → returns
    let return7d: number | null = null;
    let return30d: number | null = null;
    let maxDrawdown: number | null = null;
    let equity = 0;

    if (chartResp.status === "fulfilled") {
      const raw = chartResp.value as { balanceCharts?: Array<{ historicalBalances?: Array<{ t: number; u: number }> }> };
      const byTs = new Map<number, number>();
      for (const chart of raw.balanceCharts ?? []) {
        for (const pt of chart.historicalBalances ?? []) {
          byTs.set(pt.t, (byTs.get(pt.t) ?? 0) + pt.u);
        }
      }
      const curve = [...byTs.entries()].map(([t, eq]) => ({ t, eq })).sort((a, b) => a.t - b.t);
      if (curve.length >= 2) {
        const last = curve[curve.length - 1];
        equity = last.eq;

        // Deposit-adjusted returns: skip intervals where equity jumps >20% in one step
        const JUMP = 0.20;

        // Helper: compute cumulative return over a slice of the curve
        const adjReturn = (slice: typeof curve): number => {
          let cum = 1.0;
          for (let i = 1; i < slice.length; i++) {
            const prev = slice[i - 1].eq;
            if (prev <= 0) continue;
            const chg = (slice[i].eq - prev) / prev;
            if (Math.abs(chg) <= JUMP) cum *= (1 + chg);
          }
          return cum - 1;
        };

        // 30d return
        const cutoff30 = last.t - 30 * 86400;
        const slice30 = curve.filter(p => p.t >= cutoff30);
        if (slice30.length >= 2) return30d = adjReturn(slice30);

        // 7d return
        const cutoff7 = last.t - 7 * 86400;
        const slice7 = curve.filter(p => p.t >= cutoff7);
        if (slice7.length >= 2) return7d = adjReturn(slice7);

        // Max drawdown (deposit-adjusted)
        let peak = 1.0;
        let dd = 0;
        let cum = 1.0;
        for (let i = 1; i < curve.length; i++) {
          const prev = curve[i - 1].eq;
          if (prev <= 0) continue;
          const chg = (curve[i].eq - prev) / prev;
          if (Math.abs(chg) <= JUMP) cum *= (1 + chg);
          if (cum > peak) peak = cum;
          const d = peak > 0 ? (peak - cum) / peak : 0;
          if (d > dd) dd = d;
        }
        maxDrawdown = dd;
      }
    }

    // Positions
    let positionCount = 0;
    let totalNotional = 0;
    if (collResp.status === "fulfilled") {
      const raw = collResp.value as { collaterals?: Array<Record<string, unknown>> };
      const positions = extractPositions(raw.collaterals ?? [], prices);
      positionCount = positions.length;
      totalNotional = positions.reduce((sum, p) => sum + p.notionalUsd, 0);
      if (equity === 0) {
        // Fallback equity from collaterals
        for (const c of raw.collaterals ?? []) {
          const tokenId = c.tokenId as number;
          const price = prices.get(tokenId) ?? 1;
          equity += fromBase18(c.totalNetBalance as string) * price;
        }
      }
    }

    if (equity <= 0 && return30d === null) return null;  // no meaningful data

    return { address, equity, return7d, return30d, maxDrawdown, positionCount, totalNotional, lastActive: 0 };
  } catch {
    return null;
  }
}

/** Background scan: discover wallets and compute their performance. */
async function runLeaderboardScan(): Promise<void> {
  if (leaderboardCache.scanning) return;
  leaderboardCache.scanning = true;
  console.log("[leaderboard] Starting scan...");

  try {
    leaderboardCache.scanProgress = "Scanning Arbitrum blocks...";
    const wallets = await discoverWallets(LEADERBOARD_SCAN_DAYS);
    console.log(`[leaderboard] Found ${wallets.size} unique wallets from on-chain events`);
    leaderboardCache.walletCount = wallets.size;
    leaderboardCache.scanProgress = `Found ${wallets.size} wallets, fetching PnL data...`;

    const prices = await getTokenPrices();
    const entries: LeaderboardEntry[] = [];
    let processed = 0;

    // Process wallets in batches of 5 for faster scanning
    const walletArr = [...wallets.entries()];
    for (let i = 0; i < walletArr.length; i += 5) {
      const batch = walletArr.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(([addr]) => fetchWalletPerformance(addr, prices))
      );
      for (let j = 0; j < batch.length; j++) {
        const [addr, lastTx] = batch[j];
        const result = results[j];
        if (result.status === "fulfilled" && result.value) {
          result.value.lastActive = lastTx;
          entries.push(result.value);
        }
        processed++;
      }

      // Update progress every batch
      leaderboardCache.scanProgress = `Fetching PnL: ${processed}/${wallets.size} wallets...`;
      if (processed % 50 === 0) {
        console.log(`[leaderboard] Processed ${processed}/${wallets.size} wallets, ${entries.length} with data`);
      }

      // Small delay between batches to avoid rate limiting
      if (i + 5 < walletArr.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Sort by 30d return descending
    entries.sort((a, b) => (b.return30d ?? -Infinity) - (a.return30d ?? -Infinity));

    leaderboardCache = {
      updatedAt: Date.now(),
      scanning: false,
      entries,
      walletCount: wallets.size,
    };
    saveLeaderboardCache();
    console.log(`[leaderboard] Scan complete: ${entries.length} entries ranked`);
  } catch (err) {
    console.error("[leaderboard] Scan failed:", err);
    leaderboardCache.scanning = false;
    leaderboardCache.error = String(err);
  }
}

app.get("/api/leaderboard", (_req, res) => {
  // Trigger scan if stale
  if (!leaderboardCache.scanning && Date.now() - leaderboardCache.updatedAt > LEADERBOARD_MAX_AGE_MS) {
    runLeaderboardScan().catch(console.error);
  }
  res.json(leaderboardCache);
});

app.post("/api/leaderboard/refresh", (_req, res) => {
  if (leaderboardCache.scanning) {
    return res.json({ status: "already_scanning" });
  }
  runLeaderboardScan().catch(console.error);
  res.json({ status: "scan_started" });
});

// Load cache on startup, trigger scan if stale
loadLeaderboardCache();
if (Date.now() - leaderboardCache.updatedAt > LEADERBOARD_MAX_AGE_MS) {
  setTimeout(() => runLeaderboardScan().catch(console.error), 5000);
}

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
