import type { IndicatorBundle, IndicatorPoint, MarketSnapshot, MarketSummary, OrderBookDepth, SimulationQuote, TradeSide } from "./types.js";
import { decimalToBps, fromBase18, round } from "./utils.js";

interface ApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

interface ApiErrorBody {
  statusCode?: number;
  message?: string;
  error?: string;
  errorCode?: string;
  contractCode?: string;
}

interface SimulationResponse {
  marginRequired: string;
  liquidationApr?: number;
  priceImpact?: number;
  actualLeverage: number;
  feeBreakdown?: {
    totalFee?: string;
  };
  status: string;
}

function expectNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Invalid numeric field ${key}`);
  }
  return value;
}

function expectString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid string field ${key}`);
  }
  return value;
}

function expectBoolean(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") {
    throw new Error(`Invalid boolean field ${key}`);
  }
  return value;
}

export class BorosApiError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly pathname: string;
  public readonly bodyText?: string;
  public readonly errorCode?: string;
  public readonly contractCode?: string;

  public constructor(params: {
    status: number;
    statusText: string;
    pathname: string;
    bodyText?: string;
    errorCode?: string;
    contractCode?: string;
  }) {
    super(`Boros API request failed: ${params.status} ${params.statusText} for ${params.pathname}${params.bodyText ? ` :: ${params.bodyText}` : ""}`);
    this.name = "BorosApiError";
    this.status = params.status;
    this.statusText = params.statusText;
    this.pathname = params.pathname;
    this.bodyText = params.bodyText;
    this.errorCode = params.errorCode;
    this.contractCode = params.contractCode;
  }
}

export class BorosApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(pathname: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const body = await response.text();
      let parsed: ApiErrorBody | undefined;
      if (body) {
        try {
          parsed = JSON.parse(body) as ApiErrorBody;
        } catch {
          parsed = undefined;
        }
      }
      throw new BorosApiError({
        status: response.status,
        statusText: response.statusText,
        pathname,
        bodyText: body || undefined,
        errorCode: parsed?.errorCode,
        contractCode: parsed?.contractCode,
      });
    }
    return (await response.json()) as T;
  }

  public async fetchMarkets(limit = 100): Promise<MarketSummary[]> {
    const data = await this.request<{ results: unknown[] }>(`/v1/markets?limit=${limit}&isWhitelisted=true`);
    const results = data.results as Array<Record<string, unknown>>;
    return results.map((row) => this.parseMarketSummary(row));
  }

  public async fetchOrderBook(marketId: number, tickSize = 0.001): Promise<OrderBookDepth> {
    const data = await this.request<{
      long: { ia: number[]; sz: string[] };
      short: { ia: number[]; sz: string[] };
    }>(`/v1/order-books/${marketId}?tickSize=${tickSize}`);

    return {
      bestLongTick: data.long.ia[0],
      bestShortTick: data.short.ia[0],
      bestLongSizeBase: data.long.sz[0] ? fromBase18(data.long.sz[0]) : undefined,
      bestShortSizeBase: data.short.sz[0] ? fromBase18(data.short.sz[0]) : undefined,
    };
  }

  public async fetchIndicators(marketId: number): Promise<IndicatorBundle> {
    const data = await this.request<{ results: IndicatorPoint[] }>(
      `/v2/markets/indicators?marketId=${marketId}&timeFrame=1h&select=u,fp,udma:7;30`,
    );
    const latest = data.results.at(-1);
    if (latest?.u === undefined || latest.udma?.["7"] === undefined || latest.udma?.["30"] === undefined) {
      throw new Error(`Indicators missing required fields for market ${marketId}`);
    }

    return {
      currentUnderlyingApr: latest.u,
      futuresPremium: latest.fp,
      underlyingApr7d: latest.udma["7"],
      underlyingApr30d: latest.udma["30"],
      lastTimestamp: latest.ts,
    };
  }

  public async buildSnapshot(market: MarketSummary): Promise<MarketSnapshot> {
    const [orderBook, indicators] = await Promise.all([
      this.fetchOrderBook(market.marketId),
      this.fetchIndicators(market.marketId),
    ]);

    return {
      recordedAt: Math.floor(Date.now() / 1000),
      market,
      orderBook,
      indicators,
    };
  }

  public async simulateOrder(params: {
    marketId: number;
    side: TradeSide;
    sizeBase18: bigint;
    limitTick?: number;
    tif: number;
    slippage?: number;
  }): Promise<SimulationQuote> {
    const search = new URLSearchParams({
      marketId: String(params.marketId),
      side: params.side === "LONG" ? "0" : "1",
      size: params.sizeBase18.toString(),
      tif: String(params.tif),
    });
    if (params.limitTick !== undefined) {
      search.set("limitTick", String(params.limitTick));
    }
    if (params.slippage !== undefined) {
      search.set("slippage", String(params.slippage));
    }

    const data = await this.request<SimulationResponse>(`/v2/simulations/place-order?${search.toString()}`);
    const marginRequiredUsd = fromBase18(data.marginRequired);
    const feeUsd = data.feeBreakdown?.totalFee ? fromBase18(data.feeBreakdown.totalFee) : 0;
    const feeBps = marginRequiredUsd > 0 ? decimalToBps(feeUsd / marginRequiredUsd) : 0;

    return {
      marginRequiredUsd,
      actualLeverage: Math.abs(data.actualLeverage),
      liquidationApr: data.liquidationApr,
      liquidationBufferBps: undefined,
      priceImpactBps: round((data.priceImpact ?? 0) * 10_000, 2),
      feeBps: round(feeBps, 2),
      status: data.status,
      raw: data,
    };
  }

  public async fetchAccountEquity(userAddress: string, accountId: number): Promise<{ equity: number; availableBalance: number; initialMarginUsed: number }> {
    const data = await this.request<{
      collaterals: Array<{
        tokenId: number;
        totalNetBalance: string;
        crossPosition: {
          netBalance: string;
          availableBalance: string;
          initialMargin: string;
        };
      }>;
    }>(`/v1/collaterals/summary?userAddress=${userAddress}&accountId=${accountId}`);
    let equity = 0;
    let availableBalance = 0;
    let initialMarginUsed = 0;
    for (const c of data.collaterals ?? []) {
      equity += fromBase18(c.totalNetBalance ?? "0");
      const cross = c.crossPosition;
      if (cross) {
        availableBalance += fromBase18(cross.availableBalance ?? "0");
        initialMarginUsed += fromBase18(cross.initialMargin ?? "0");
      }
    }
    return { equity, availableBalance, initialMarginUsed };
  }

  public async fetchActivePositions(userAddress: string, accountId: number): Promise<Array<Record<string, unknown>>> {
    const data = await this.request<{
      collaterals: Array<{
        tokenId: number;
        isolatedPositions: Array<{
          marketPositions: Array<Record<string, unknown>>;
        }>;
        crossPosition: {
          marketPositions: Array<Record<string, unknown>>;
        };
      }>;
    }>(`/v1/collaterals/summary?userAddress=${userAddress}&accountId=${accountId}`);

    const positions: Array<Record<string, unknown>> = [];
    for (const collateral of data.collaterals ?? []) {
      // Cross margin positions
      for (const pos of collateral.crossPosition?.marketPositions ?? []) {
        positions.push({ ...pos, tokenId: collateral.tokenId });
      }
      // Isolated positions
      for (const isolated of collateral.isolatedPositions ?? []) {
        for (const pos of isolated.marketPositions ?? []) {
          positions.push({ ...pos, tokenId: collateral.tokenId });
        }
      }
    }
    return positions;
  }

  private parseMarketSummary(row: Record<string, unknown>): MarketSummary {
    const imData = row.imData as Record<string, unknown>;
    const metadata = row.metadata as Record<string, unknown>;
    const extConfig = row.extConfig as Record<string, unknown>;
    const data = row.data as Record<string, unknown>;
    return {
      marketId: expectNumber(row, "marketId"),
      tokenId: expectNumber(row, "tokenId"),
      address: expectString(row, "address"),
      state: expectString(row, "state"),
      name: expectString(imData, "name"),
      symbol: expectString(imData, "symbol"),
      tickStep: expectNumber(imData, "tickStep"),
      isIsolatedOnly: expectBoolean(imData, "isIsolatedOnly"),
      platformName: expectString(metadata, "platformName"),
      assetSymbol: expectString(metadata, "assetSymbol"),
      isWhitelisted: expectBoolean(metadata, "isWhitelisted"),
      maturityTimestamp: expectNumber(imData, "maturity"),
      maxLeverage: expectNumber(metadata, "maxLeverage"),
      defaultLeverage: expectNumber(metadata, "defaultLeverage"),
      marginFloor: expectNumber(imData, "marginFloor"),
      paymentPeriodSeconds: expectNumber(extConfig, "paymentPeriod"),
      nextSettlementTime: expectNumber(data, "nextSettlementTime"),
      timeToMaturitySeconds: expectNumber(data, "timeToMaturity"),
      assetMarkPrice: expectNumber(data, "assetMarkPrice"),
      midApr: expectNumber(data, "midApr"),
      markApr: expectNumber(data, "markApr"),
      bestBid: expectNumber(data, "bestBid"),
      bestAsk: expectNumber(data, "bestAsk"),
      floatingApr: expectNumber(data, "floatingApr"),
      longYieldApr: expectNumber(data, "longYieldApr"),
      volume24h: expectNumber(data, "volume24h"),
      notionalOi: expectNumber(data, "notionalOI"),
    };
  }
}
