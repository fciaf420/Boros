export type TradeSide = "LONG" | "SHORT";
export type ActionType = "ENTER" | "EXIT" | "ADD" | "HOLD";
export type OrderIntent = "maker" | "taker";
export type PositionStatus = "OPEN" | "CLOSED";
export type OrderLifecycleStatus = "SUBMITTED" | "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "REJECTED";
export type TraderMode = "paper" | "live";

export interface MarketSummary {
  marketId: number;
  tokenId: number;
  address: string;
  state: string;
  name: string;
  symbol: string;
  tickStep: number;
  isIsolatedOnly: boolean;
  platformName: string;
  assetSymbol: string;
  isWhitelisted: boolean;
  maturityTimestamp: number;
  maxLeverage: number;
  defaultLeverage: number;
  marginFloor: number;
  paymentPeriodSeconds: number;
  nextSettlementTime: number;
  timeToMaturitySeconds: number;
  assetMarkPrice: number;
  midApr: number;
  markApr: number;
  bestBid: number;
  bestAsk: number;
  floatingApr: number;
  longYieldApr: number;
  volume24h: number;
  notionalOi: number;
}

export interface OrderBookDepth {
  bestLongTick?: number;
  bestShortTick?: number;
  bestLongSizeBase?: number;
  bestShortSizeBase?: number;
}

export interface IndicatorPoint {
  ts: number;
  u?: number;
  fp?: number;
  udma?: Record<string, number>;
}

export interface IndicatorBundle {
  currentUnderlyingApr: number;
  futuresPremium?: number;
  underlyingApr7d: number;
  underlyingApr30d: number;
  lastTimestamp: number;
}

export interface MarketSnapshot {
  recordedAt: number;
  market: MarketSummary;
  orderBook: OrderBookDepth;
  indicators: IndicatorBundle;
}

export interface FairValueEstimate {
  marketId: number;
  fairApr: number;
  sources: number[];
  clippedSources: number[];
  edgeBpsLong: number;
  edgeBpsShort: number;
}

export interface SimulationQuote {
  marginRequiredUsd: number;
  actualLeverage: number;
  liquidationApr?: number;
  liquidationBufferBps?: number;
  priceImpactBps: number;
  feeBps: number;
  status: string;
  raw: unknown;
}

export interface TradeCandidate {
  marketId: number;
  tokenId: number;
  isIsolatedOnly: boolean;
  side: TradeSide;
  action: ActionType;
  orderIntent: OrderIntent;
  edgeBps: number;
  netEdgeBps: number;
  targetApr: number;
  orderTick?: number;
  orderApr: number;
  sizeBase: number;
  sizeBase18: bigint;
  notionalUsd: number;
  plannedMarginUsd: number;
  simulation: SimulationQuote;
  rationale: string;
}

export interface OpenPosition {
  id: string;
  marketId: number;
  tokenId: number;
  marketName: string;
  assetSymbol: string;
  isIsolatedOnly: boolean;
  marketAcc?: string;
  side: TradeSide;
  status: PositionStatus;
  openedAt: number;
  closedAt?: number;
  entryApr: number;
  currentApr: number;
  fixedApr: number;
  floatingApr: number;
  sizeBase: number;
  sizeBase18: string;
  assetMarkPrice: number;
  notionalUsd: number;
  initialMarginUsd: number;
  actualLeverage: number;
  liquidationApr?: number;
  liquidationBufferBps?: number;
  addCount: number;
  realizedCarryPnlUsd: number;
  realizedTradingPnlUsd: number;
  unrealizedPnlUsd: number;
  peakPnlUsd: number;
  peakPnlPct: number;
  lastAccrualTs: number;
  lastSignalEdgeBps: number;
}

export interface ExecutionRecord {
  clientOrderId: string;
  mode: TraderMode;
  candidate: TradeCandidate;
  status: OrderLifecycleStatus;
  fillApr: number;
  executedAt: number;
  externalOrderId?: string;
  marketAcc?: string;
  requestedSizeBase18: string;
  placedSizeBase18?: string;
  filledSizeBase18: string;
  remainingSizeBase18: string;
  appliedSizeBase18: string;
  blockTimestamp?: number;
  lastReconciledAt: number;
  notes?: string;
}

export interface RiskState {
  equityUsd: number;
  usedInitialMarginUsd: number;
  openPositions: OpenPosition[];
  failureStreak: number;
  killSwitchActive: boolean;
  dailyBaselineUsd: number;
  dailyPnlPct: number;
}

export interface CopyRiskState {
  failureStreak: number;
  dailyPnlUsd: number;
  killSwitchActive: boolean;
  killSwitchReason?: string;
  currentPositionCount: number;
}

export interface MarketEvaluation {
  snapshot: MarketSnapshot;
  fairValue: FairValueEstimate;
  candidate?: TradeCandidate;
  reasonSkipped?: string;
}

export interface CycleTopEdge {
  marketId: number;
  marketName: string;
  side: TradeSide;
  action?: ActionType;
  edgeBps: number;
  netEdgeBps?: number;
  fairApr: number;
  midApr: number;
  reason?: string;
}

export interface CycleAction {
  marketId: number;
  marketName: string;
  side: TradeSide;
  action: ActionType;
  label: string;
  intent: OrderIntent;
  orderStatus: OrderLifecycleStatus;
  fillApr: number;
  netEdgeBps: number;
}

export interface CycleSummary {
  fetchedMarkets: number;
  eligibleMarkets: number;
  snapshotMarkets: number;
  snapshotErrors: string[];
  openPositions: number;
  killSwitchActive: boolean;
  topEdges: CycleTopEdge[];
  skipReasonCounts: Array<{ reason: string; count: number }>;
  actions: CycleAction[];
}

export type DeltaAction = "ENTER" | "EXIT" | "INCREASE" | "DECREASE";

export interface CopyTradeConfig {
  enabled: boolean;
  targetAddress: `0x${string}`;
  targetAccountId?: number;
  pollingMs: number;
  sizeRatio: number;
  maxNotionalUsd: number;
  maxSlippage: number;
  discordWebhookUrl?: string;
  minOrderNotionalUsd: number;
  roundUpToMinNotional: boolean;
  maxConcurrentPositions: number;
  delayBetweenOrdersMs: number;
  deltaDeadzone: number;
  maxFailureStreak: number;
  maxDailyDrawdownPct: number;
  minLiquidityCoverage: number;
}

export interface TargetPositionSnapshot {
  marketId: number;
  side: TradeSide;
  sizeBase: number;
  sizeBase18: string;
  entryApr: number;
  currentApr: number;
}

export interface TargetPositionDelta {
  action: DeltaAction;
  marketId: number;
  side: TradeSide;
  sizeChangeBase: number;
  targetNewSizeBase: number;
  targetEntryApr: number;
}

export interface CopyTradeRecord {
  id: string;
  deltaAction: DeltaAction;
  targetMarketId: number;
  targetSide: TradeSide;
  targetSizeBase: number;
  ourClientOrderId?: string;
  ourSizeBase: number;
  status: "EXECUTED" | "SKIPPED" | "FAILED";
  reason?: string;
  timestamp: number;
}

export interface CopyPosition {
  id: string;
  marketId: number;
  side: TradeSide;
  sizeBase: number;
  sizeBase18: string;
  entryApr: number;
  notionalUsd: number;
  marginUsd: number;
  status: "OPEN" | "CLOSED";
  openedAt: number;
  closedAt?: number;
  clientOrderId?: string;
}
