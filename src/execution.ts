import { randomUUID } from "node:crypto";
import { Agent, CROSS_MARKET_ID, Exchange, MarketAccLib, Side, Subaccount, TimeInForce } from "@pendle/sdk-boros";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { TraderConfig } from "./config.js";
import type { ExecutionRecord, OpenPosition, OrderLifecycleStatus, TradeCandidate, TraderMode } from "./types.js";
import { fromBase18 } from "./utils.js";

export interface BrokerReconciliation {
  orders: ExecutionRecord[];
  notes: string[];
}

export interface BrokerPositionSync {
  positions: OpenPosition[];
  notes: string[];
}

export interface Broker {
  readonly mode: TraderMode;
  execute(candidate: TradeCandidate, existingPosition?: OpenPosition): Promise<ExecutionRecord>;
  reconcile(activeOrders: ExecutionRecord[]): Promise<BrokerReconciliation>;
  syncPositions(positions: OpenPosition[]): Promise<BrokerPositionSync>;
  cancel(order: ExecutionRecord, reason: string): Promise<ExecutionRecord>;
  sweepIsolatedCash(markets: Array<{ marketId: number; tokenId: number }>): Promise<string[]>;
}

type ContractOpenOrder = {
  orderId: string;
  size?: bigint;
  unfilledSize?: bigint;
};

function toBase18String(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.round(value * 1e18)).toString();
  }

  if (typeof value === "string") {
    if (/^-?\d+$/.test(value)) {
      return value;
    }
    return BigInt(Math.round(Number(value) * 1e18)).toString();
  }

  if (typeof value === "object" && value !== null) {
    const maybeFixed = value as { value?: bigint; toString?: () => string };
    if (typeof maybeFixed.value === "bigint") {
      return maybeFixed.value.toString();
    }
    if (typeof maybeFixed.toString === "function") {
      const rendered = maybeFixed.toString();
      if (/^-?\d+$/.test(rendered)) {
        return rendered;
      }
      return BigInt(Math.round(Number(rendered) * 1e18)).toString();
    }
  }

  return "0";
}

function deriveOrderStatus(params: {
  requestedSizeBase18: bigint;
  filledSizeBase18: bigint;
  remainingSizeBase18: bigint;
  externalOrderId?: string;
}): OrderLifecycleStatus {
  const { requestedSizeBase18, filledSizeBase18, remainingSizeBase18, externalOrderId } = params;
  if (filledSizeBase18 >= requestedSizeBase18 && requestedSizeBase18 > 0n) {
    return "FILLED";
  }
  if (externalOrderId && remainingSizeBase18 > 0n && filledSizeBase18 > 0n) {
    return "PARTIALLY_FILLED";
  }
  if (externalOrderId && remainingSizeBase18 > 0n) {
    return "OPEN";
  }
  if (filledSizeBase18 > 0n) {
    return "FILLED";
  }
  return "CANCELLED";
}

function buildExecutionRecord(params: {
  mode: TraderMode;
  candidate: TradeCandidate;
  clientOrderId?: string;
  fillApr: number;
  executedAt?: number;
  externalOrderId?: string;
  marketAcc?: string;
  status: OrderLifecycleStatus;
  requestedSizeBase18: bigint | string;
  placedSizeBase18?: bigint | string;
  filledSizeBase18: bigint | string;
  remainingSizeBase18: bigint | string;
  appliedSizeBase18?: bigint | string;
  blockTimestamp?: number;
  lastReconciledAt?: number;
  notes?: string;
}): ExecutionRecord {
  const executedAt = params.executedAt ?? Math.floor(Date.now() / 1000);
  return {
    clientOrderId: params.clientOrderId ?? randomUUID(),
    mode: params.mode,
    candidate: params.candidate,
    status: params.status,
    fillApr: params.fillApr,
    executedAt,
    externalOrderId: params.externalOrderId,
    marketAcc: params.marketAcc,
    requestedSizeBase18: typeof params.requestedSizeBase18 === "bigint"
      ? params.requestedSizeBase18.toString()
      : params.requestedSizeBase18,
    placedSizeBase18: params.placedSizeBase18 === undefined
      ? undefined
      : typeof params.placedSizeBase18 === "bigint"
        ? params.placedSizeBase18.toString()
        : params.placedSizeBase18,
    filledSizeBase18: typeof params.filledSizeBase18 === "bigint"
      ? params.filledSizeBase18.toString()
      : params.filledSizeBase18,
    remainingSizeBase18: typeof params.remainingSizeBase18 === "bigint"
      ? params.remainingSizeBase18.toString()
      : params.remainingSizeBase18,
    appliedSizeBase18: params.appliedSizeBase18 === undefined
      ? "0"
      : typeof params.appliedSizeBase18 === "bigint"
        ? params.appliedSizeBase18.toString()
        : params.appliedSizeBase18,
    blockTimestamp: params.blockTimestamp,
    lastReconciledAt: params.lastReconciledAt ?? executedAt,
    notes: params.notes,
  };
}

export class PaperBroker implements Broker {
  public readonly mode = "paper" as const;

  public constructor(private readonly config: TraderConfig) {}

  public async execute(candidate: TradeCandidate): Promise<ExecutionRecord> {
    const fillApr = this.config.paperAssumeTakerEntry ? candidate.orderApr : candidate.targetApr;
    return buildExecutionRecord({
      mode: this.mode,
      candidate,
      status: "FILLED",
      fillApr,
      requestedSizeBase18: candidate.sizeBase18,
      filledSizeBase18: candidate.sizeBase18,
      remainingSizeBase18: 0n,
      appliedSizeBase18: 0n,
      notes: candidate.orderIntent === "maker"
        ? "Paper mode uses conservative crossing fills for maker-intent entries."
        : "Paper mode fill",
    });
  }

  public async reconcile(): Promise<BrokerReconciliation> {
    return { orders: [], notes: [] };
  }

  public async syncPositions(positions: OpenPosition[]): Promise<BrokerPositionSync> {
    return { positions, notes: [] };
  }

  public async cancel(order: ExecutionRecord, reason: string): Promise<ExecutionRecord> {
    return {
      ...order,
      status: order.filledSizeBase18 === "0" ? "CANCELLED" : "FILLED",
      lastReconciledAt: Math.floor(Date.now() / 1000),
      notes: [order.notes, reason].filter(Boolean).join(" | "),
    };
  }

  public async sweepIsolatedCash(): Promise<string[]> {
    return [];
  }
}

export class LiveBroker implements Broker {
  public readonly mode = "live" as const;
  private exchange?: Exchange;
  private agentReady = false;
  private walletClient?: ReturnType<typeof createWalletClient>;
  private signerAddress?: `0x${string}`;
  private subaccount?: Subaccount;
  private readonly enteredIsolatedMarkets = new Set<number>();

  public constructor(private readonly config: TraderConfig) {}

  private getRootAddress(): `0x${string}` {
    if (!this.signerAddress) {
      throw new Error("Signer address not initialized");
    }
    return this.config.rootAddress ?? this.signerAddress;
  }

  private async getExchange(): Promise<Exchange> {
    if (this.exchange) {
      return this.exchange;
    }

    if (!this.config.privateKey || this.config.accountId === undefined || !this.config.rpcUrl) {
      throw new Error("Live mode requires BOROS_PRIVATE_KEY, BOROS_ACCOUNT_ID, and BOROS_RPC_URL");
    }

    const account = privateKeyToAccount(this.config.privateKey);
    const rootAddress = this.config.rootAddress ?? account.address;
    if (rootAddress.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error("BOROS_ROOT_ADDRESS must match the private key wallet address");
    }
    const walletClient = createWalletClient({
      account,
      transport: http(this.config.rpcUrl),
    });
    this.walletClient = walletClient;
    this.signerAddress = account.address;

    this.exchange = new Exchange(walletClient, account.address, this.config.accountId, [this.config.rpcUrl]);
    return this.exchange;
  }

  private async ensureAgent(exchange: Exchange): Promise<void> {
    if (this.agentReady) {
      return;
    }
    if (!this.walletClient) {
      throw new Error("Wallet client not initialized");
    }
    const { agent } = await Agent.create(this.walletClient);
    await exchange.approveAgent(agent);
    this.agentReady = true;
  }

  private getSubaccount(): Subaccount {
    if (!this.subaccount) {
      this.subaccount = new Subaccount();
    }
    return this.subaccount;
  }

  private async ensureIsolatedCash(candidate: TradeCandidate): Promise<void> {
    if (!candidate.isIsolatedOnly || this.config.accountId === undefined) {
      return;
    }

    if (!this.config.autoFundIsolatedMarkets) {
      throw new Error(
        `isolated market ${candidate.marketId} requires market-specific cash. ` +
        "Enable BOROS_AUTO_FUND_ISOLATED_MARKETS=true or prefund the isolated subaccount manually.",
      );
    }

    const exchange = await this.getExchange();
    if (!this.enteredIsolatedMarkets.has(candidate.marketId)) {
      await exchange.enterMarkets(false, [candidate.marketId]);
      this.enteredIsolatedMarkets.add(candidate.marketId);
    }

    const subaccount = this.getSubaccount();
    const currentCash = await subaccount.getMarketAccCash(
      this.getRootAddress(),
      this.config.accountId,
      candidate.tokenId,
      candidate.marketId,
    );
    const availableCash = fromBase18(currentCash);
    const requiredCash = Math.max(
      candidate.plannedMarginUsd * (1 + (this.config.isolatedMarginBufferBps / 10_000)),
      this.config.minIsolatedCashTopupUsd,
    );

    if (availableCash + 1e-9 < requiredCash) {
      const transferAmount = BigInt(Math.ceil((requiredCash - availableCash) * 1e18));
      await exchange.cashTransfer({
        marketId: candidate.marketId,
        isDeposit: true,
        amount: transferAmount,
      });
    }
  }

  private getOrderMarketAcc(order: ExecutionRecord): string {
    if (order.marketAcc) {
      return order.marketAcc;
    }
    if (this.config.accountId === undefined) {
      throw new Error("Live mode requires BOROS_ACCOUNT_ID");
    }
    return MarketAccLib.pack(
      this.getRootAddress(),
      this.config.accountId,
      order.candidate.tokenId,
      order.candidate.isIsolatedOnly ? order.candidate.marketId : CROSS_MARKET_ID,
    );
  }

  private async fetchOpenOrders(order: ExecutionRecord): Promise<Map<string, ContractOpenOrder>> {
    const exchange = await this.getExchange();
    const response = await exchange.getPnlLimitOrders({
      tokenId: order.candidate.tokenId,
      marketId: order.candidate.marketId,
      isActive: true,
      fromContract: true,
    }) as { results?: Array<Record<string, unknown>> };

    const result = new Map<string, ContractOpenOrder>();
    for (const item of response.results ?? []) {
      const orderId = String(item.orderId ?? "");
      if (!orderId) {
        continue;
      }
      result.set(orderId, {
        orderId,
        size: typeof item.size === "bigint" ? item.size : BigInt(String(item.size ?? "0")),
        unfilledSize: typeof item.unfilledSize === "bigint" ? item.unfilledSize : BigInt(String(item.unfilledSize ?? "0")),
      });
    }
    return result;
  }

  public async execute(candidate: TradeCandidate): Promise<ExecutionRecord> {
    const exchange = await this.getExchange();
    await this.ensureAgent(exchange);

    const marketAcc = MarketAccLib.pack(
      this.getRootAddress(),
      this.config.accountId!,
      candidate.tokenId,
      candidate.isIsolatedOnly ? candidate.marketId : CROSS_MARKET_ID,
    );

    if (this.config.dryRun) {
      return buildExecutionRecord({
        mode: this.mode,
        candidate,
        status: "REJECTED",
        fillApr: candidate.orderApr,
        marketAcc,
        requestedSizeBase18: candidate.sizeBase18,
        filledSizeBase18: 0n,
        remainingSizeBase18: candidate.sizeBase18,
        notes: "Dry run enabled; no live order submitted.",
      });
    }

    if (this.config.accountId === undefined) {
      throw new Error("Live mode requires BOROS_ACCOUNT_ID");
    }

    await this.ensureIsolatedCash(candidate);

    const tif = candidate.orderIntent === "maker"
      ? TimeInForce.ADD_LIQUIDITY_ONLY
      : TimeInForce.FILL_OR_KILL;
    const side = candidate.side === "LONG" ? Side.LONG : Side.SHORT;

    const response = await exchange.placeOrder({
      marketAcc,
      marketId: candidate.marketId,
      side,
      size: candidate.sizeBase18,
      limitTick: candidate.orderTick,
      tif,
      slippage: candidate.orderIntent === "maker" ? undefined : this.config.marketOrderSlippage,
    }) as { result?: { order?: Record<string, unknown>; events?: unknown[] } };

    const order = response.result?.order ?? {};
    const requestedSizeBase18 = candidate.sizeBase18;
    const placedSizeBase18 = order.placedSize === undefined ? undefined : BigInt(toBase18String(order.placedSize));
    const externalOrderId = order.orderId === undefined ? undefined : String(order.orderId);
    const filledSizeBase18 = candidate.orderIntent === "taker" && !externalOrderId
      ? requestedSizeBase18
      : BigInt(toBase18String(order.filledSize));
    const remainingSizeBase18 = externalOrderId
      ? (placedSizeBase18 ?? (requestedSizeBase18 > filledSizeBase18 ? requestedSizeBase18 - filledSizeBase18 : 0n))
      : 0n;
    const blockTimestamp = typeof order.blockTimestamp === "number" ? order.blockTimestamp : undefined;
    const status = deriveOrderStatus({
      requestedSizeBase18,
      filledSizeBase18,
      remainingSizeBase18,
      externalOrderId,
    });

    return buildExecutionRecord({
      mode: this.mode,
      candidate,
      status,
      fillApr: candidate.orderApr,
      externalOrderId,
      marketAcc,
      requestedSizeBase18,
      placedSizeBase18,
      filledSizeBase18,
      remainingSizeBase18,
      blockTimestamp,
      notes: "Live order submitted through Boros SDK",
    });
  }

  public async reconcile(activeOrders: ExecutionRecord[]): Promise<BrokerReconciliation> {
    if (activeOrders.length === 0) {
      return { orders: [], notes: [] };
    }

    const grouped = new Map<string, ExecutionRecord[]>();
    for (const order of activeOrders) {
      const key = `${order.candidate.tokenId}:${order.candidate.marketId}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(order);
      grouped.set(key, bucket);
    }

    const notes: string[] = [];
    const updatedOrders: ExecutionRecord[] = [];

    for (const orders of grouped.values()) {
      const liveOpenOrders = await this.fetchOpenOrders(orders[0]);

      for (const order of orders) {
        if (!order.externalOrderId) {
          updatedOrders.push({
            ...order,
            status: BigInt(order.filledSizeBase18) > 0n ? "FILLED" : "CANCELLED",
            remainingSizeBase18: "0",
            lastReconciledAt: Math.floor(Date.now() / 1000),
          });
          continue;
        }

        const liveOrder = liveOpenOrders.get(order.externalOrderId);
        if (liveOrder) {
          const remainingSizeBase18 = liveOrder.unfilledSize ?? liveOrder.size ?? 0n;
          const requestedSizeBase18 = BigInt(order.requestedSizeBase18);
          const filledSizeBase18 = requestedSizeBase18 > remainingSizeBase18
            ? requestedSizeBase18 - remainingSizeBase18
            : 0n;
          updatedOrders.push({
            ...order,
            status: deriveOrderStatus({
              requestedSizeBase18,
              filledSizeBase18,
              remainingSizeBase18,
              externalOrderId: order.externalOrderId,
            }),
            placedSizeBase18: (liveOrder.size ?? remainingSizeBase18).toString(),
            filledSizeBase18: filledSizeBase18.toString(),
            remainingSizeBase18: remainingSizeBase18.toString(),
            lastReconciledAt: Math.floor(Date.now() / 1000),
            notes: order.notes,
          });
          continue;
        }

        const terminalStatus = BigInt(order.filledSizeBase18) > 0n ? "FILLED" : "CANCELLED";
        updatedOrders.push({
          ...order,
          status: terminalStatus,
          remainingSizeBase18: "0",
          lastReconciledAt: Math.floor(Date.now() / 1000),
          notes: [order.notes, "Order no longer active on contract."].filter(Boolean).join(" | "),
        });
      }
    }

    if (notes.length === 0) {
      notes.push(`reconciled ${updatedOrders.length} live order(s)`);
    }
    return { orders: updatedOrders, notes };
  }

  public async syncPositions(positions: OpenPosition[]): Promise<BrokerPositionSync> {
    const openPositions = positions.filter((position) => position.status === "OPEN");
    if (openPositions.length === 0) {
      return { positions, notes: [] };
    }

    const exchange = await this.getExchange();
    const marketEntries = new Map<string, Array<Record<string, unknown>>>();
    for (const position of openPositions) {
      const key = `${position.tokenId}:${position.marketId}`;
      if (marketEntries.has(key)) {
        continue;
      }

      const livePositions = await exchange.getUserPositions({
        marketId: position.marketId,
        tokenId: position.tokenId,
      }) as Array<Record<string, unknown>>;
      marketEntries.set(key, livePositions);
    }

    const now = Math.floor(Date.now() / 1000);
    const notes: string[] = [];
    const syncedPositions = positions.map((position) => {
      if (position.status !== "OPEN") {
        return position;
      }

      const livePositions = marketEntries.get(`${position.tokenId}:${position.marketId}`) ?? [];
      const livePosition = livePositions.find((entry) => {
        const marketAcc = entry.marketAcc === undefined ? undefined : String(entry.marketAcc);
        return position.marketAcc ? marketAcc === position.marketAcc : true;
      });

      const signedSizeBase18 = livePosition?.signedSize === undefined
        ? 0n
        : BigInt(String(livePosition.signedSize));
      const absoluteSizeBase18 = signedSizeBase18 < 0n ? -signedSizeBase18 : signedSizeBase18;

      if (absoluteSizeBase18 === 0n) {
        notes.push(`closed stale local position for market ${position.marketId} after UI/manual close`);
        return {
          ...position,
          status: "CLOSED" as const,
          closedAt: now,
          realizedTradingPnlUsd: position.realizedTradingPnlUsd + position.unrealizedPnlUsd,
          unrealizedPnlUsd: 0,
          lastAccrualTs: now,
        };
      }

      const liveSide: OpenPosition["side"] = signedSizeBase18 >= 0n ? "LONG" : "SHORT";
      const liveInitialMargin = livePosition?.initialMargin === undefined
        ? position.initialMarginUsd
        : fromBase18(BigInt(String(livePosition.initialMargin)));
      const liveLiquidationApr = livePosition?.liquidationApr === undefined
        ? position.liquidationApr
        : fromBase18(BigInt(String(livePosition.liquidationApr)));

      return {
        ...position,
        side: liveSide,
        marketAcc: livePosition?.marketAcc === undefined ? position.marketAcc : String(livePosition.marketAcc),
        sizeBase: fromBase18(absoluteSizeBase18),
        sizeBase18: absoluteSizeBase18.toString(),
        initialMarginUsd: liveInitialMargin > 0 ? liveInitialMargin : position.initialMarginUsd,
        liquidationApr: liveLiquidationApr,
      };
    });

    return { positions: syncedPositions, notes };
  }

  public async cancel(order: ExecutionRecord, reason: string): Promise<ExecutionRecord> {
    if (!order.externalOrderId) {
      return {
        ...order,
        status: BigInt(order.filledSizeBase18) > 0n ? "FILLED" : "CANCELLED",
        remainingSizeBase18: "0",
        lastReconciledAt: Math.floor(Date.now() / 1000),
        notes: [order.notes, reason].filter(Boolean).join(" | "),
      };
    }

    const exchange = await this.getExchange();
    await this.ensureAgent(exchange);
    await exchange.cancelOrders({
      marketAcc: this.getOrderMarketAcc(order) as `0x${string}`,
      marketId: order.candidate.marketId,
      cancelAll: false,
      orderIds: [order.externalOrderId],
    });

    return {
      ...order,
      status: BigInt(order.filledSizeBase18) > 0n ? "FILLED" : "CANCELLED",
      remainingSizeBase18: "0",
      lastReconciledAt: Math.floor(Date.now() / 1000),
      notes: [order.notes, reason].filter(Boolean).join(" | "),
    };
  }

  public async sweepIsolatedCash(markets: Array<{ marketId: number; tokenId: number }>): Promise<string[]> {
    if (markets.length === 0 || this.config.accountId === undefined) {
      return [];
    }

    const exchange = await this.getExchange();
    await this.ensureAgent(exchange);

    const rootAddress = this.getRootAddress();
    const subaccount = this.getSubaccount();
    const seen = new Set<string>();
    const notes: string[] = [];

    for (const market of markets) {
      const key = `${market.tokenId}:${market.marketId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const cash = await subaccount.getMarketAccCash(rootAddress, this.config.accountId, market.tokenId, market.marketId);
      if (cash <= 0n) {
        continue;
      }

      await exchange.cashTransfer({
        marketId: market.marketId,
        isDeposit: false,
        amount: cash,
      });
      notes.push(`swept ${fromBase18(cash).toFixed(4)} collateral from isolated market ${market.marketId}`);
    }

    return notes;
  }
}
