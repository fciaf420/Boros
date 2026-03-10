import { describe, expect, it } from "vitest";
import { BorosApiClient, BorosApiError } from "../src/borosApi.js";

describe("BorosApiClient", () => {
  it("parses market summaries from the official API shape", async () => {
    const client = new BorosApiClient({
      baseUrl: "https://example.invalid",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                marketId: 23,
                tokenId: 1,
                address: "0x0",
                state: "Normal",
                imData: {
                  name: "Binance BTCUSDT 27 Mar 2026",
                  symbol: "BINANCE-BTCUSDT-27MAR2026",
                  maturity: 1774569600,
                  tickStep: 2,
                  isIsolatedOnly: false,
                  marginFloor: 0.06,
                },
                extConfig: {
                  paymentPeriod: 28800,
                },
                metadata: {
                  platformName: "Binance",
                  assetSymbol: "BTC",
                  isWhitelisted: true,
                  maxLeverage: 3,
                  defaultLeverage: 3,
                },
                data: {
                  nextSettlementTime: 1773100800,
                  timeToMaturity: 1497600,
                  assetMarkPrice: 68546.66,
                  midApr: 0.0193,
                  markApr: 0.0194,
                  bestBid: 0.0191,
                  bestAsk: 0.0195,
                  floatingApr: -0.0233,
                  longYieldApr: -0.7136,
                  volume24h: 283.54,
                  notionalOI: 356.25,
                },
              },
            ],
          }),
        ),
    });

    const markets = await client.fetchMarkets(10);
    expect(markets[0].marketId).toBe(23);
    expect(markets[0].platformName).toBe("Binance");
    expect(markets[0].midApr).toBeCloseTo(0.0193);
  });

  it("exposes Boros error codes from failed simulation requests", async () => {
    const client = new BorosApiClient({
      baseUrl: "https://example.invalid",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            statusCode: 400,
            message: "TradeALOAMMNotAllowed()",
            errorCode: "TRADE_ALOAMM_NOT_ALLOWED",
            contractCode: "TradeALOAMMNotAllowed",
          }),
          { status: 400, statusText: "Bad Request" },
        ),
    });

    await expect(client.simulateOrder({
      marketId: 24,
      side: "SHORT",
      sizeBase18: 1n,
      limitTick: 10,
      tif: 3,
    })).rejects.toMatchObject({
      name: "BorosApiError",
      errorCode: "TRADE_ALOAMM_NOT_ALLOWED",
      contractCode: "TradeALOAMMNotAllowed",
    });
  });

  it("normalizes negative leverage magnitudes from simulation responses", async () => {
    const client = new BorosApiClient({
      baseUrl: "https://example.invalid",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            marginRequired: "1000000000000000000",
            actualLeverage: -0.75,
            priceImpact: -0.01,
            status: "WalletNotConnected",
          }),
        ),
    });

    const quote = await client.simulateOrder({
      marketId: 58,
      side: "SHORT",
      sizeBase18: 1n,
      limitTick: -48,
      tif: 1,
    });

    expect(quote.actualLeverage).toBe(0.75);
  });
});
