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
