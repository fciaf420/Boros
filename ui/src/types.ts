export interface MarketSummary {
  marketId: number;
  tokenId: number;
  address: string;
  state: string;
  imData: {
    name: string;
    symbol: string;
    tickStep: number;
    isIsolatedOnly: boolean;
    maturity: number;
    marginFloor: number;
  };
  metadata: {
    platformName: string;
    assetSymbol: string;
    isWhitelisted: boolean;
    maxLeverage: number;
    defaultLeverage: number;
  };
  extConfig: {
    paymentPeriod: number;
  };
  data: {
    nextSettlementTime: number;
    timeToMaturity: number;
    assetMarkPrice: number;
    midApr: number;
    markApr: number;
    bestBid: number;
    bestAsk: number;
    floatingApr: number;
    longYieldApr: number;
    volume24h: number;
    notionalOI: number;
  };
}

export interface MarketsResponse {
  results: MarketSummary[];
}

export interface PositionRow {
  id: string;
  market_id: number;
  market_name: string;
  asset_symbol: string;
  side: string;
  status: string;
  opened_at: number;
  entry_apr: number;
  current_apr: number;
  fixed_apr: number;
  floating_apr: number;
  size_base: number;
  notional_usd: number;
  initial_margin_usd: number;
  actual_leverage: number;
  liquidation_apr: number | null;
  liquidation_buffer_bps: number | null;
  realized_carry_pnl_usd: number;
  realized_trading_pnl_usd: number;
  unrealized_pnl_usd: number;
  last_signal_edge_bps: number;
  is_isolated_only: number;
}

export interface OrderRow {
  id: number;
  recorded_at: number;
  market_id: number;
  side: string;
  action: string;
  order_intent: string;
  size_base: number;
  order_apr: number;
  edge_bps: number;
  net_edge_bps: number;
  mode: string;
  status: string;
  fill_apr: number;
  notes: string | null;
}

export interface SignalRow {
  id: number;
  recorded_at: number;
  market_id: number;
  fair_apr: number;
  edge_bps_long: number;
  edge_bps_short: number;
  candidate_json: string | null;
}

export interface KillEventRow {
  id: number;
  recorded_at: number;
  reason: string;
}

export interface AppState {
  mode: string;
  copyTradeEnabled: boolean;
  strategyState: Record<string, string>;
  runtimeState: Record<string, unknown>;
  killSwitchActive: boolean;
}

export interface RatesData {
  generated_at: string;
  markets: Array<{
    market: string;
    implied: number;
    underlying: number;
    days: number | null;
    spread: number;
    spread_bps: number;
    exchange?: string;
    maturity?: string;
  }>;
}

export interface CopyPositionRow {
  id: string;
  market_id: number;
  side: string;
  size_base: number;
  size_base18: string;
  entry_apr: number;
  notional_usd: number;
  margin_usd: number;
  status: string;
  opened_at: number;
  closed_at: number | null;
  client_order_id: string | null;
}

export interface CopyTradeRow {
  id: string;
  delta_action: string;
  target_market_id: number;
  target_side: string;
  target_size_base: number;
  our_client_order_id: string | null;
  our_size_base: number;
  status: string;
  reason: string | null;
  recorded_at: number;
  raw_json: string | null;
}

export interface CopyTargetRow {
  id: number;
  recorded_at: number;
  target_address: string;
  snapshot_json: string;
}

export interface RiskState {
  equityUsd: number;
  usedInitialMarginUsd: number;
  dailyPnlPct: number;
  failureStreak: number;
  killSwitchActive: boolean;
  dailyBaselineUsd?: number;
  openPositions?: Array<{ marketId: number; side: string }>;
}

export interface TradeCandidate {
  marketId: number;
  side: "LONG" | "SHORT";
  action: "ENTER" | "EXIT" | "ADD" | "HOLD";
  orderIntent: "maker" | "taker";
  edgeBps: number;
  netEdgeBps: number;
  targetApr: number;
  orderApr: number;
  sizeBase: number;
  notionalUsd: number;
  plannedMarginUsd: number;
  simulation: {
    marginRequiredUsd: number;
    actualLeverage: number;
    liquidationApr?: number;
    liquidationBufferBps?: number;
    priceImpactBps: number;
    feeBps: number;
    status: string;
  };
  rationale: string;
}

export interface TargetPositionSnapshot {
  marketId: number;
  side: "LONG" | "SHORT";
  sizeBase: number;
  sizeBase18: string;
  entryApr: number;
  currentApr: number;
}

export interface AccountSummary {
  equity: number;           // total net balance in USD across all collaterals
  availableBalance: number;
  initialMarginUsed: number;
  startDayEquity: number;   // for computing daily PnL
  collateralBreakdown: Array<{
    tokenId: number;
    netBalance: number;
    availableBalance: number;
    initialMargin: number;
  }>;
  error?: string;
}

export interface OnChainPosition {
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
}

export interface OnChainPositionsResponse {
  positions: OnChainPosition[];
  error?: string;
}
