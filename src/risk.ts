import type { TraderConfig } from "./config.js";
import type { MarketSnapshot, OpenPosition, RiskState, TradeSide } from "./types.js";
import { markToMarketPnlUsd, signedCarryPnlUsd, toBase18 } from "./utils.js";

export function openPositionPnlUsd(position: OpenPosition): number {
  return position.realizedCarryPnlUsd + position.realizedTradingPnlUsd + position.unrealizedPnlUsd;
}

export function openPositionPnlPct(position: OpenPosition): number {
  if (position.initialMarginUsd <= 0) {
    return 0;
  }
  return openPositionPnlUsd(position) / position.initialMarginUsd;
}

export function refreshOpenPosition(position: OpenPosition, snapshot: MarketSnapshot): OpenPosition {
  const now = snapshot.recordedAt;
  const elapsed = Math.max(0, now - position.lastAccrualTs);
  const realizedCarry = signedCarryPnlUsd(
    position.side,
    snapshot.market.floatingApr,
    position.fixedApr,
    position.notionalUsd,
    elapsed,
  );
  const remaining = snapshot.market.timeToMaturitySeconds;
  const unrealized = markToMarketPnlUsd(
    position.side,
    snapshot.market.midApr,
    position.entryApr,
    position.notionalUsd,
    remaining,
  );
  const nextRealizedCarryPnlUsd = position.realizedCarryPnlUsd + realizedCarry;
  const nextTotalPnlUsd = nextRealizedCarryPnlUsd + position.realizedTradingPnlUsd + unrealized;
  const nextTotalPnlPct = position.initialMarginUsd <= 0 ? 0 : nextTotalPnlUsd / position.initialMarginUsd;

  return {
    ...position,
    currentApr: snapshot.market.midApr,
    floatingApr: snapshot.market.floatingApr,
    assetMarkPrice: snapshot.market.assetMarkPrice,
    liquidationBufferBps:
      position.liquidationApr === undefined ? undefined : Math.abs(snapshot.market.midApr - position.liquidationApr) * 10_000,
    realizedCarryPnlUsd: nextRealizedCarryPnlUsd,
    unrealizedPnlUsd: unrealized,
    peakPnlUsd: Math.max(position.peakPnlUsd, nextTotalPnlUsd),
    peakPnlPct: Math.max(position.peakPnlPct, nextTotalPnlPct),
    lastAccrualTs: now,
  };
}

export function computeRiskState(config: TraderConfig, positions: OpenPosition[], failureStreak: number, baselineUsd: number): RiskState {
  const openPositions = positions.filter((position) => position.status === "OPEN");
  const pnlUsd = positions.reduce(
    (sum, position) => sum + openPositionPnlUsd(position),
    0,
  );
  const equityUsd = config.startingEquityUsd + pnlUsd;
  const usedInitialMarginUsd = openPositions.reduce((sum, position) => sum + position.initialMarginUsd, 0);
  const dailyPnlPct = baselineUsd === 0 ? 0 : (equityUsd - baselineUsd) / baselineUsd;

  return {
    equityUsd,
    usedInitialMarginUsd,
    openPositions,
    failureStreak,
    killSwitchActive: dailyPnlPct <= -config.maxDailyDrawdownPct || failureStreak >= config.maxFailureStreak,
    dailyBaselineUsd: baselineUsd,
    dailyPnlPct,
  };
}

export function remainingMarginBudget(config: TraderConfig, state: RiskState): number {
  const cap = state.equityUsd * config.maxTotalInitialMarginPct;
  return Math.max(0, cap - state.usedInitialMarginUsd);
}

export function perMarketMarginBudget(config: TraderConfig, state: RiskState): number {
  const remainingBudgetUsd = remainingMarginBudget(config, state);
  const remainingSlots = Math.max(1, config.maxConcurrentMarkets - state.openPositions.length);
  const perSlotBudgetUsd = remainingBudgetUsd / remainingSlots;
  return Math.min(state.equityUsd * config.maxInitialMarginPctPerMarket, perSlotBudgetUsd);
}

export function allocateSignalWeightedBudgets(
  signals: Array<{ key: string; score: number }>,
  totalBudgetUsd: number,
  perMarketCapUsd: number,
  maxCount: number,
): Map<string, number> {
  const selected = signals
    .slice(0, Math.max(0, maxCount))
    .map((signal) => ({
      key: signal.key,
      score: Math.max(signal.score, 0),
    }))
    .filter((signal) => signal.score > 0);

  const budgets = new Map<string, number>();
  let remainingBudgetUsd = Math.max(0, totalBudgetUsd);
  let remainingScore = selected.reduce((sum, signal) => sum + signal.score, 0);

  for (const signal of selected) {
    if (remainingBudgetUsd <= 0 || remainingScore <= 0) {
      break;
    }

    const rawBudgetUsd = remainingBudgetUsd * (signal.score / remainingScore);
    const allocatedBudgetUsd = Math.min(perMarketCapUsd, rawBudgetUsd);
    budgets.set(signal.key, allocatedBudgetUsd);
    remainingBudgetUsd -= allocatedBudgetUsd;
    remainingScore -= signal.score;
  }

  return budgets;
}

export function orderBookLiquidity(side: TradeSide, snapshot: MarketSnapshot): number {
  return side === "LONG"
    ? (snapshot.orderBook.bestShortSizeBase ?? 0)
    : (snapshot.orderBook.bestLongSizeBase ?? 0);
}

export function chooseInitialSizeBase(config: TraderConfig, marginBudgetUsd: number, snapshot: MarketSnapshot): number {
  const targetLeverage = Math.min(snapshot.market.defaultLeverage, snapshot.market.maxLeverage, config.maxEffectiveLeverage);
  return marginBudgetUsd * targetLeverage;
}

export function makePositionId(marketId: number, timestamp: number, side: TradeSide): string {
  return `${marketId}:${side}:${timestamp}`;
}

export function sizeAsBase18(sizeBase: number): bigint {
  return toBase18(sizeBase);
}
