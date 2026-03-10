import type { FairValueEstimate, MarketSnapshot } from "./types.js";
import { clamp, decimalToBps, median, round } from "./utils.js";

export function estimateFairValue(snapshot: MarketSnapshot, clipAprWindowBps: number): FairValueEstimate {
  const inputs = [
    snapshot.indicators.currentUnderlyingApr,
    snapshot.indicators.underlyingApr7d,
    snapshot.indicators.underlyingApr30d,
    snapshot.indicators.futuresPremium,
  ].filter((value): value is number => value !== undefined);

  const clipWindow = clipAprWindowBps / 10_000;
  const clipped = inputs.map((value) => clamp(value, snapshot.market.midApr - clipWindow, snapshot.market.midApr + clipWindow));
  const fairApr = round(median(clipped), 6);

  return {
    marketId: snapshot.market.marketId,
    fairApr,
    sources: inputs,
    clippedSources: clipped,
    edgeBpsLong: round(decimalToBps(fairApr - snapshot.market.midApr), 2),
    edgeBpsShort: round(decimalToBps(snapshot.market.midApr - fairApr), 2),
  };
}
