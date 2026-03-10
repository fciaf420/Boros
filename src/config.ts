import type { CopyTradeConfig } from "./types.js";
import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv();

function getEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getOptionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }
  return value;
}

function getOptionalBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function getOptionalNumberList(name: string): number[] | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }

  const values = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part));

  if (values.some((value) => Number.isNaN(value))) {
    throw new Error(`Invalid numeric list environment variable: ${name}`);
  }

  return values;
}

export type TraderMode = "paper" | "live";

export interface TraderConfig {
  mode: TraderMode;
  apiBaseUrl: string;
  rpcUrl?: string;
  pollingIntervalMs: number;
  sqlitePath: string;
  maxMarkets: number;
  startingEquityUsd: number;
  minDaysToMaturity: number;
  minEdgeBps: number;
  maxEntryCostBps: number;
  safetyBufferBps: number;
  exitEdgeBps: number;
  aggressiveEntryEdgeBps: number;
  maxInitialMarginPctPerMarket: number;
  maxTotalInitialMarginPct: number;
  maxConcurrentMarkets: number;
  maxEffectiveLeverage: number;
  marginUtilizationTargetPct: number;
  minOrderNotionalUsd: number;
  allowedMarketIds?: number[];
  allowIsolatedMarkets: boolean;
  autoFundIsolatedMarkets: boolean;
  isolatedMarginBufferBps: number;
  minIsolatedCashTopupUsd: number;
  autoCancelStaleLiveOrders: boolean;
  liveEntryOrderTtlSeconds: number;
  liveExitOrderTtlSeconds: number;
  minLiquidityCoverage: number;
  minEntryLiqBufferBps: number;
  minMaintainLiqBufferBps: number;
  maxDailyDrawdownPct: number;
  maxFailureStreak: number;
  clipAprWindowBps: number;
  marketOrderSlippage: number;
  takeProfitPnlPct: number;
  stopLossPnlPct: number;
  trailingStopArmPct: number;
  trailingStopGivebackPct: number;
  paperAssumeTakerEntry: boolean;
  dryRun: boolean;
  accountId?: number;
  rootAddress?: `0x${string}`;
  privateKey?: `0x${string}`;
  copyTrade: CopyTradeConfig;
}

export function loadConfig(cwd = process.cwd()): TraderConfig {
  const mode = (process.env.BOROS_MODE ?? "paper").toLowerCase() as TraderMode;
  if (mode !== "paper" && mode !== "live") {
    throw new Error(`Unsupported BOROS_MODE: ${mode}`);
  }

  const sqlitePath = process.env.BOROS_SQLITE_PATH
    ? path.resolve(cwd, process.env.BOROS_SQLITE_PATH)
    : path.resolve(cwd, "data", "boros_trader.sqlite");

  return {
    mode,
    apiBaseUrl: getEnv("BOROS_API_BASE_URL", "https://api.boros.finance/core"),
    rpcUrl: process.env.BOROS_RPC_URL,
    pollingIntervalMs: getOptionalNumber("BOROS_POLLING_INTERVAL_MS", 60_000),
    sqlitePath,
    maxMarkets: getOptionalNumber("BOROS_MAX_MARKETS", 100),
    startingEquityUsd: getOptionalNumber("BOROS_STARTING_EQUITY_USD", 100_000),
    minDaysToMaturity: getOptionalNumber("BOROS_MIN_DAYS_TO_MATURITY", 14),
    minEdgeBps: getOptionalNumber("BOROS_MIN_EDGE_BPS", 150),
    maxEntryCostBps: getOptionalNumber("BOROS_MAX_ENTRY_COST_BPS", 50),
    safetyBufferBps: getOptionalNumber("BOROS_SAFETY_BUFFER_BPS", 50),
    exitEdgeBps: getOptionalNumber("BOROS_EXIT_EDGE_BPS", 50),
    aggressiveEntryEdgeBps: getOptionalNumber("BOROS_AGGRESSIVE_ENTRY_BPS", 300),
    maxInitialMarginPctPerMarket: getOptionalNumber("BOROS_MAX_INITIAL_MARGIN_PCT_PER_MARKET", 0.10),
    maxTotalInitialMarginPct: getOptionalNumber("BOROS_MAX_TOTAL_INITIAL_MARGIN_PCT", 0.35),
    maxConcurrentMarkets: getOptionalNumber("BOROS_MAX_CONCURRENT_MARKETS", 3),
    maxEffectiveLeverage: getOptionalNumber("BOROS_MAX_EFFECTIVE_LEVERAGE", 1.5),
    marginUtilizationTargetPct: getOptionalNumber("BOROS_MARGIN_UTILIZATION_TARGET_PCT", 0.85),
    minOrderNotionalUsd: getOptionalNumber("BOROS_MIN_ORDER_NOTIONAL_USD", 10),
    allowedMarketIds: getOptionalNumberList("BOROS_ALLOWED_MARKET_IDS"),
    allowIsolatedMarkets: getOptionalBoolean("BOROS_ALLOW_ISOLATED_MARKETS", true),
    autoFundIsolatedMarkets: getOptionalBoolean("BOROS_AUTO_FUND_ISOLATED_MARKETS", true),
    isolatedMarginBufferBps: getOptionalNumber("BOROS_ISOLATED_MARGIN_BUFFER_BPS", 500),
    minIsolatedCashTopupUsd: getOptionalNumber("BOROS_MIN_ISOLATED_CASH_TOPUP_USD", 10),
    autoCancelStaleLiveOrders: getOptionalBoolean("BOROS_AUTO_CANCEL_STALE_LIVE_ORDERS", true),
    liveEntryOrderTtlSeconds: getOptionalNumber("BOROS_LIVE_ENTRY_ORDER_TTL_SECONDS", 600),
    liveExitOrderTtlSeconds: getOptionalNumber("BOROS_LIVE_EXIT_ORDER_TTL_SECONDS", 180),
    minLiquidityCoverage: getOptionalNumber("BOROS_MIN_LIQUIDITY_COVERAGE", 3),
    minEntryLiqBufferBps: getOptionalNumber("BOROS_MIN_ENTRY_LIQ_BUFFER_BPS", 400),
    minMaintainLiqBufferBps: getOptionalNumber("BOROS_MIN_MAINTAIN_LIQ_BUFFER_BPS", 200),
    maxDailyDrawdownPct: getOptionalNumber("BOROS_MAX_DAILY_DRAWDOWN_PCT", 0.03),
    maxFailureStreak: getOptionalNumber("BOROS_MAX_FAILURE_STREAK", 2),
    clipAprWindowBps: getOptionalNumber("BOROS_CLIP_APR_WINDOW_BPS", 500),
    marketOrderSlippage: getOptionalNumber("BOROS_MARKET_ORDER_SLIPPAGE", 0.05),
    takeProfitPnlPct: getOptionalNumber("BOROS_TAKE_PROFIT_PCT", 0.25),
    stopLossPnlPct: getOptionalNumber("BOROS_STOP_LOSS_PCT", 0.15),
    trailingStopArmPct: getOptionalNumber("BOROS_TRAILING_STOP_ARM_PCT", 0.15),
    trailingStopGivebackPct: getOptionalNumber("BOROS_TRAILING_STOP_GIVEBACK_PCT", 0.10),
    paperAssumeTakerEntry: getOptionalBoolean("BOROS_PAPER_ASSUME_TAKER_ENTRY", true),
    dryRun: getOptionalBoolean("BOROS_DRY_RUN", false),
    accountId: process.env.BOROS_ACCOUNT_ID ? Number(process.env.BOROS_ACCOUNT_ID) : undefined,
    rootAddress: process.env.BOROS_ROOT_ADDRESS as `0x${string}` | undefined,
    privateKey: process.env.BOROS_PRIVATE_KEY as `0x${string}` | undefined,
    copyTrade: {
      enabled: getOptionalBoolean("BOROS_COPY_TRADE_ENABLED", false),
      targetAddress: (process.env.BOROS_COPY_TRADE_TARGET_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
      targetAccountId: process.env.BOROS_COPY_TRADE_TARGET_ACCOUNT_ID ? Number(process.env.BOROS_COPY_TRADE_TARGET_ACCOUNT_ID) : undefined,
      pollingMs: getOptionalNumber("BOROS_COPY_TRADE_POLLING_MS", 10_000),
      sizeRatio: getOptionalNumber("BOROS_COPY_TRADE_SIZE_RATIO", 1.0),
      maxNotionalUsd: getOptionalNumber("BOROS_COPY_TRADE_MAX_NOTIONAL_USD", 5_000),
      maxSlippage: getOptionalNumber("BOROS_COPY_TRADE_MAX_SLIPPAGE", 0.10),
      discordWebhookUrl: process.env.BOROS_COPY_TRADE_DISCORD_WEBHOOK_URL || undefined,
    },
  };
}
