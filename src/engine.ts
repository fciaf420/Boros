import type { TraderConfig } from "./config.js";
import { BorosApiClient, BorosApiError } from "./borosApi.js";
import { RuntimeStore } from "./db.js";
import { LiveBroker, PaperBroker, type Broker } from "./execution.js";
import { allocateSignalWeightedBudgets, chooseInitialSizeBase, computeRiskState, makePositionId, openPositionPnlPct, openPositionPnlUsd, orderBookLiquidity, perMarketMarginBudget, refreshOpenPosition, remainingMarginBudget, sizeAsBase18 } from "./risk.js";
import { estimateFairValue } from "./strategy.js";
import type { ActionType, CycleAction, CycleSummary, ExecutionRecord, MarketEvaluation, MarketSnapshot, OpenPosition, TradeCandidate, TradeSide } from "./types.js";
import { decimalToBps, fromBase18 } from "./utils.js";

const MAKER_TIF = 3;
const TAKER_TIF = 2;
const YEAR_SECONDS = 365 * 24 * 3600;
const MAX_EXECUTION_RETRIES = 6;

export class RelativeValueTrader {
  private readonly broker: Broker;
  private failureStreak = 0;

  public constructor(
    private readonly config: TraderConfig,
    private readonly api: BorosApiClient,
    private readonly store: RuntimeStore,
  ) {
    this.broker = config.mode === "live" ? new LiveBroker(config) : new PaperBroker(config);
  }

  public async runOnce(): Promise<CycleSummary> {
    const baselineKey = `baseline:${new Date().toISOString().slice(0, 10)}`;
    let allPositions = this.store.getAllPositions();
    if (this.config.mode === "live" && allPositions.some((position) => position.status === "OPEN")) {
      const synced = await this.broker.syncPositions(allPositions);
      allPositions = synced.positions;
      for (const position of allPositions) {
        this.store.upsertPosition(position);
      }
      if (synced.notes.length > 0) {
        this.store.setRuntimeValue("last_position_sync_notes", synced.notes);
      }
    }
    const openPositions = allPositions.filter((position) => position.status === "OPEN");
    const storedBaseline = this.store.getRuntimeValue<number>(baselineKey);
    const baseline = this.normalizeDailyBaseline(storedBaseline, openPositions);
    const preRisk = computeRiskState(this.config, allPositions, this.failureStreak, baseline);
    if (storedBaseline !== baseline) {
      this.store.setRuntimeValue(baselineKey, baseline);
    } else if (storedBaseline === undefined) {
      this.store.setRuntimeValue(baselineKey, preRisk.equityUsd);
    }

    let fetchedMarkets = 0;
    let eligibleMarkets = 0;
    let snapshotErrors: string[] = [];

    try {
      const allMarkets = await this.api.fetchMarkets(this.config.maxMarkets);
      fetchedMarkets = allMarkets.length;
      const markets = allMarkets
        .filter((market) =>
          (!this.config.allowedMarketIds || this.config.allowedMarketIds.includes(market.marketId)) &&
          market.isWhitelisted &&
          market.state === "Normal" &&
          (this.config.allowIsolatedMarkets || !market.isIsolatedOnly) &&
          market.timeToMaturitySeconds >= this.config.minDaysToMaturity * 24 * 3600,
        );
      eligibleMarkets = markets.length;

      const snapshotResults = await Promise.allSettled(markets.map((market) => this.api.buildSnapshot(market)));
      const snapshots = snapshotResults
        .filter((result): result is PromiseFulfilledResult<MarketSnapshot> => result.status === "fulfilled")
        .map((result) => result.value);
      const failedSnapshots = snapshotResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected");
      snapshotErrors = failedSnapshots.map((result) => String(result.reason));
      if (failedSnapshots.length > 0) {
        this.store.setRuntimeValue("last_snapshot_errors", snapshotErrors);
      }
      const snapshotByMarket = new Map(snapshots.map((snapshot) => [snapshot.market.marketId, snapshot]));

      for (const snapshot of snapshots) {
        this.store.saveSnapshot(snapshot);
      }

      const positionsForCycle = allPositions.map((position) => {
        if (position.status !== "OPEN") {
          return position;
        }
        const snapshot = snapshotByMarket.get(position.marketId);
        const refreshed = snapshot ? refreshOpenPosition(position, snapshot) : position;
        this.store.upsertPosition(refreshed);
        return refreshed;
      });

      let activeOrders = this.store.getActiveOrders();
      if (this.config.mode === "live" && activeOrders.length > 0) {
        const reconciliation = await this.broker.reconcile(activeOrders);
        const isolatedSweepMarkets = reconciliation.orders
          .filter((order) => !this.isOrderActive(order))
          .filter((order) => order.candidate.isIsolatedOnly)
          .filter((order) => BigInt(order.filledSizeBase18) === 0n)
          .map((order) => ({ marketId: order.candidate.marketId, tokenId: order.candidate.tokenId }));
        for (const order of reconciliation.orders) {
          const appliedOrder = this.applyOrderExecution(order, positionsForCycle, snapshotByMarket);
          this.store.saveOrder(appliedOrder);
        }
        if (reconciliation.notes.length > 0) {
          this.store.setRuntimeValue("last_reconciliation_notes", reconciliation.notes);
        }
        if (isolatedSweepMarkets.length > 0) {
          const sweepNotes = await this.broker.sweepIsolatedCash(isolatedSweepMarkets);
          if (sweepNotes.length > 0) {
            this.store.setRuntimeValue("last_isolated_sweeps", sweepNotes);
          }
        }
        activeOrders = reconciliation.orders.filter((order) => this.isOrderActive(order));
      }

      if (this.config.mode === "live" && this.config.autoCancelStaleLiveOrders && activeOrders.length > 0) {
        const staleOrders = await this.cancelStaleLiveOrders(activeOrders);
        for (const order of staleOrders) {
          const appliedOrder = this.applyOrderExecution(order, positionsForCycle, snapshotByMarket);
          this.store.saveOrder(appliedOrder);
        }
        activeOrders = this.store.getActiveOrders();
      }

      const riskState = computeRiskState(this.config, positionsForCycle, this.failureStreak, baseline);
      this.store.saveRiskState(riskState);

      if (riskState.killSwitchActive) {
        this.store.appendKillSwitchEvent("kill-switch-active", riskState);
        return this.buildCycleSummary({
          fetchedMarkets,
          eligibleMarkets,
          snapshots,
          snapshotErrors,
          evaluations: [],
          actions: [],
          openPositions: positionsForCycle,
          killSwitchActive: true,
        });
      }

      const liveOpenPositions = positionsForCycle.filter((position) => position.status === "OPEN");
      const evaluations = await this.evaluateMarkets(snapshots, liveOpenPositions, riskState, activeOrders);

      for (const evaluation of evaluations) {
        this.store.saveSignal(evaluation.fairValue, evaluation.candidate);
      }

      const exitActions = await this.handleExits(evaluations, positionsForCycle, activeOrders);
      const entryActions = await this.handleEntries(evaluations, positionsForCycle, activeOrders, riskState);

      if (this.config.mode === "live") {
        const sweepNotes = await this.sweepClosedIsolatedCash(positionsForCycle, activeOrders);
        if (sweepNotes.length > 0) {
          this.store.setRuntimeValue("last_isolated_sweeps", sweepNotes);
        }
      }

      this.failureStreak = 0;
      return this.buildCycleSummary({
        fetchedMarkets,
        eligibleMarkets,
        snapshots,
        snapshotErrors,
        evaluations,
        actions: [...exitActions, ...entryActions],
        openPositions: positionsForCycle,
        killSwitchActive: false,
      });
    } catch (error) {
      this.failureStreak += 1;
      this.store.setRuntimeValue("last_error", {
        at: Math.floor(Date.now() / 1000),
        message: error instanceof Error ? error.message : String(error),
      });
      if (this.failureStreak >= this.config.maxFailureStreak) {
        this.store.appendKillSwitchEvent("failure-streak", { failureStreak: this.failureStreak });
      }
      throw error;
    }
  }

  private async evaluateMarkets(
    snapshots: MarketSnapshot[],
    openPositions: OpenPosition[],
    riskState: ReturnType<typeof computeRiskState>,
    activeOrders: ExecutionRecord[],
  ): Promise<MarketEvaluation[]> {
    const evaluations: MarketEvaluation[] = [];

    for (const snapshot of snapshots) {
      const fairValue = estimateFairValue(snapshot, this.config.clipAprWindowBps);
      const open = openPositions.find((position) => position.marketId === snapshot.market.marketId && position.status === "OPEN");
      const result = await this.buildCandidate(snapshot, fairValue, riskState, activeOrders, open);
      evaluations.push({
        snapshot,
        fairValue,
        candidate: result.candidate,
        reasonSkipped: result.reason,
      });
    }

    return evaluations.sort((left, right) => (right.candidate?.netEdgeBps ?? -Infinity) - (left.candidate?.netEdgeBps ?? -Infinity));
  }

  private async buildCandidate(
    snapshot: MarketSnapshot,
    fairValue: ReturnType<typeof estimateFairValue>,
    riskState: ReturnType<typeof computeRiskState>,
    activeOrders: ExecutionRecord[],
    existingPosition?: OpenPosition,
    marginBudgetOverrideUsd?: number,
  ): Promise<{ candidate?: TradeCandidate; reason?: string }> {
    const longEdge = fairValue.edgeBpsLong;
    const shortEdge = fairValue.edgeBpsShort;
    const formatTradeAttempt = (sizeBase: number, orderApr?: number, orderIntent?: "maker" | "taker"): string => {
      const approxTradeValueUsd = sizeBase;
      const parts = [
        `size=${sizeBase.toFixed(6)}`,
        `trade_value~$${approxTradeValueUsd.toFixed(2)}`,
      ];
      if (orderApr !== undefined) {
        parts.push(`apr=${orderApr.toFixed(4)}`);
      }
      if (orderIntent) {
        parts.push(`intent=${orderIntent}`);
      }
      return parts.join(" ");
    };
    const reject = (reason: string, detail?: string) => ({ reason: detail ? `${reason} (${detail})` : reason });

    if (activeOrders.some((order) => order.candidate.marketId === snapshot.market.marketId)) {
      return reject("active live order pending");
    }

    let side: TradeSide | undefined;
    let action: "ENTER" | "EXIT" | "ADD";

    if (existingPosition) {
      const activeEdge = existingPosition.side === "LONG" ? longEdge : shortEdge;
      const flipped = existingPosition.side === "LONG" ? shortEdge >= this.config.exitEdgeBps : longEdge >= this.config.exitEdgeBps;
      const liquidationBreach = existingPosition.liquidationBufferBps !== undefined
        && existingPosition.liquidationBufferBps < this.config.minMaintainLiqBufferBps;
      const positionPnlUsd = openPositionPnlUsd(existingPosition);
      const positionPnlPct = openPositionPnlPct(existingPosition);
      const takeProfitHit = positionPnlPct >= this.config.takeProfitPnlPct;
      const stopLossHit = positionPnlPct <= -this.config.stopLossPnlPct;
      const trailingStopHit =
        existingPosition.peakPnlPct >= this.config.trailingStopArmPct &&
        positionPnlPct <= (existingPosition.peakPnlPct - this.config.trailingStopGivebackPct);
      if (activeEdge < this.config.exitEdgeBps || flipped || liquidationBreach || takeProfitHit || stopLossHit || trailingStopHit) {
        side = existingPosition.side === "LONG" ? "SHORT" : "LONG";
        action = "EXIT";
        if (takeProfitHit) {
          return this.buildForcedExitCandidate(snapshot, fairValue.fairApr, existingPosition, side, activeEdge, "TakeProfit", `EXIT ${side} because take-profit hit at ${(positionPnlPct * 100).toFixed(2)}% of initial margin`, {
            pnlUsd: positionPnlUsd,
            pnlPct: positionPnlPct,
            peakPnlPct: existingPosition.peakPnlPct,
          });
        }
        if (stopLossHit) {
          return this.buildForcedExitCandidate(snapshot, fairValue.fairApr, existingPosition, side, activeEdge, "StopLoss", `EXIT ${side} because stop-loss hit at ${(positionPnlPct * 100).toFixed(2)}% of initial margin`, {
            pnlUsd: positionPnlUsd,
            pnlPct: positionPnlPct,
            peakPnlPct: existingPosition.peakPnlPct,
          });
        }
        if (trailingStopHit) {
          return this.buildForcedExitCandidate(snapshot, fairValue.fairApr, existingPosition, side, activeEdge, "TrailingStop", `EXIT ${side} because trailing stop gave back ${((existingPosition.peakPnlPct - positionPnlPct) * 100).toFixed(2)}% from a ${(existingPosition.peakPnlPct * 100).toFixed(2)}% peak`, {
            pnlUsd: positionPnlUsd,
            pnlPct: positionPnlPct,
            peakPnlUsd: existingPosition.peakPnlUsd,
            peakPnlPct: existingPosition.peakPnlPct,
          });
        }
      } else if (
        existingPosition.addCount < 1 &&
        activeEdge > existingPosition.lastSignalEdgeBps + 25 &&
        existingPosition.unrealizedPnlUsd >= 0
      ) {
        side = existingPosition.side;
        action = "ADD";
      } else {
        return reject("open position held: exit and add rules not triggered");
      }
    } else {
      if (riskState.openPositions.length >= this.config.maxConcurrentMarkets || remainingMarginBudget(this.config, riskState) <= 0) {
        return reject("portfolio limit reached");
      }
      if (longEdge >= this.config.minEdgeBps) {
        side = "LONG";
      } else if (shortEdge >= this.config.minEdgeBps) {
        side = "SHORT";
      } else {
        return reject("raw edge below entry threshold");
      }
      action = "ENTER";
    }

    const edgeBps = side === "LONG" ? longEdge : shortEdge;
    let orderIntent: "maker" | "taker" = action === "EXIT"
      ? "taker"
      : (edgeBps >= this.config.aggressiveEntryEdgeBps ? "taker" : "maker");
    let orderApr = this.selectOrderApr(snapshot, side, orderIntent);
    let orderTick = this.selectOrderTick(snapshot, side, orderIntent);
    const marginBudgetUsd = action === "EXIT"
      ? (existingPosition?.initialMarginUsd ?? 0)
      : (marginBudgetOverrideUsd ?? perMarketMarginBudget(this.config, riskState));
    let sizeBase = action === "EXIT"
      ? (existingPosition?.sizeBase ?? 0)
      : chooseInitialSizeBase(this.config, marginBudgetUsd, snapshot);
    if (sizeBase <= 0) {
      return reject("size resolved to zero", `margin_budget=$${marginBudgetUsd.toFixed(2)}`);
    }

    const liquidity = orderBookLiquidity(side, snapshot);
    if (action !== "EXIT" && liquidity <= 0) {
      return reject("insufficient top-of-book liquidity", formatTradeAttempt(sizeBase, orderApr, orderIntent));
    }

    const maxLiquiditySizeBase = action === "EXIT"
      ? sizeBase
      : liquidity / this.config.minLiquidityCoverage;
    if (action !== "EXIT" && maxLiquiditySizeBase <= 0) {
      return reject("insufficient top-of-book liquidity", formatTradeAttempt(sizeBase, orderApr, orderIntent));
    }
    sizeBase = Math.min(sizeBase, maxLiquiditySizeBase);
    if (sizeBase <= 0) {
      return reject("size resolved to zero", `liquidity_capped ${formatTradeAttempt(maxLiquiditySizeBase, orderApr, orderIntent)}`);
    }
    if (action !== "EXIT") {
      if (sizeBase < this.config.minOrderNotionalUsd) {
        return reject(
          "order notional below minimum",
          `${formatTradeAttempt(sizeBase, orderApr, orderIntent)} min_notional=$${this.config.minOrderNotionalUsd.toFixed(2)}`,
        );
      }
    }
    const maxExecutionGrowthSizeBase = action === "EXIT"
      ? sizeBase
      : maxLiquiditySizeBase;

    let simulation;
    let sizeBase18: bigint;
    try {
      const prepared = await this.prepareExecutableOrder({
        action,
        edgeBps,
        marginBudgetUsd,
        maxLiquiditySizeBase: maxExecutionGrowthSizeBase,
        orderIntent,
        marketId: snapshot.market.marketId,
        side,
        sizeBase,
        snapshot,
      });
      sizeBase = prepared.sizeBase;
      sizeBase18 = prepared.sizeBase18;
      orderIntent = prepared.orderIntent;
      orderApr = prepared.orderApr;
      orderTick = prepared.orderTick;
      simulation = prepared.simulation;
    } catch (error) {
      return reject(
        error instanceof Error ? error.message : String(error),
        formatTradeAttempt(sizeBase, orderApr, orderIntent),
      );
    }

    // Boros simulation can return WalletNotConnected while still providing
    // usable margin/liquidation/impact fields. The UI can still trade in this
    // state once the actual signed order is submitted, so we must not reject
    // those candidates before live execution.
    const usableStatuses = new Set<string>(["success", "walletnotconnected"]);
    if (!usableStatuses.has(simulation.status.toLowerCase())) {
      return reject(`simulation returned status=${simulation.status}`, formatTradeAttempt(sizeBase, orderApr, orderIntent));
    }

    const liquidationBufferBps = simulation.liquidationApr === undefined
      ? undefined
      : decimalToBps(Math.abs(orderApr - simulation.liquidationApr));
    const totalCostsBps = simulation.priceImpactBps + simulation.feeBps + this.config.safetyBufferBps;
    const netEdgeBps = edgeBps - totalCostsBps;

    if (action !== "EXIT") {
      if ((simulation.priceImpactBps + simulation.feeBps) > this.config.maxEntryCostBps) {
        return reject("entry costs above limit", formatTradeAttempt(sizeBase, orderApr, orderIntent));
      }
      if (orderIntent === "taker" && edgeBps < this.config.aggressiveEntryEdgeBps) {
        return reject("taker entries require aggressive edge", formatTradeAttempt(sizeBase, orderApr, orderIntent));
      }
      if (netEdgeBps < this.config.minEdgeBps) {
        return reject("net edge below threshold after costs", formatTradeAttempt(sizeBase, orderApr, orderIntent));
      }
      if (Math.abs(simulation.actualLeverage) > this.config.maxEffectiveLeverage) {
        return reject("simulated leverage above limit", formatTradeAttempt(sizeBase, orderApr, orderIntent));
      }
      if (simulation.marginRequiredUsd > marginBudgetUsd) {
        return reject(
          "margin required exceeds budget",
          `${formatTradeAttempt(sizeBase, orderApr, orderIntent)} margin_required=$${simulation.marginRequiredUsd.toFixed(2)} budget=$${marginBudgetUsd.toFixed(2)}`,
        );
      }
      if ((liquidationBufferBps ?? 0) < this.config.minEntryLiqBufferBps) {
        return reject(
          "liquidation buffer below entry minimum",
          `${formatTradeAttempt(sizeBase, orderApr, orderIntent)} liq_buffer=${(liquidationBufferBps ?? 0).toFixed(1)}bps`,
        );
      }
    }

    return {
      candidate: {
        marketId: snapshot.market.marketId,
        tokenId: snapshot.market.tokenId,
        isIsolatedOnly: snapshot.market.isIsolatedOnly,
        side,
        action,
        orderIntent,
        edgeBps,
        netEdgeBps,
        targetApr: fairValue.fairApr,
        orderTick,
        orderApr,
        sizeBase,
        sizeBase18,
        notionalUsd: sizeBase,
        plannedMarginUsd: simulation.marginRequiredUsd,
        simulation: {
          ...simulation,
          liquidationBufferBps,
        },
        rationale: `${action} ${side} because fair APR ${fairValue.fairApr.toFixed(4)} vs mid ${snapshot.market.midApr.toFixed(4)} leaves ${netEdgeBps.toFixed(1)} bps net edge`,
      },
    };
  }

  private async handleEntries(
    evaluations: MarketEvaluation[],
    positions: OpenPosition[],
    activeOrders: ExecutionRecord[],
    riskState: ReturnType<typeof computeRiskState>,
  ): Promise<CycleAction[]> {
    const actions: CycleAction[] = [];
    const openPositionCount = positions.filter((position) => position.status === "OPEN").length;
    const availableSlots = Math.max(0, this.config.maxConcurrentMarkets - openPositionCount);
    if (availableSlots <= 0) {
      return actions;
    }

    const perMarketCapUsd = riskState.equityUsd * this.config.maxInitialMarginPctPerMarket;
    const weightedBudgets = allocateSignalWeightedBudgets(
      evaluations
        .flatMap((evaluation) => {
          if (!evaluation.candidate || evaluation.candidate.action !== "ENTER") {
            return [];
          }
          return [{
            key: String(evaluation.snapshot.market.marketId),
            score: Math.max(evaluation.candidate.netEdgeBps, evaluation.candidate.edgeBps, this.config.minEdgeBps),
          }];
        }),
      remainingMarginBudget(this.config, riskState),
      perMarketCapUsd,
      availableSlots,
    );

    const candidates = evaluations
      .flatMap((evaluation) => {
        if (!evaluation.candidate || evaluation.candidate.action === "EXIT") {
          return [];
        }
        return [{ evaluation, candidate: evaluation.candidate, snapshot: evaluation.snapshot }];
      })
      .slice(0, this.config.maxConcurrentMarkets);

    for (const { evaluation, candidate, snapshot } of candidates) {
      const position = positions.find((row) => row.marketId === candidate.marketId && row.status === "OPEN");
      if (candidate.action === "ENTER" && position) {
        continue;
      }
      let executableCandidate = candidate;
      if (candidate.action === "ENTER") {
        const weightedBudgetUsd = weightedBudgets.get(String(candidate.marketId));
        if (!weightedBudgetUsd || weightedBudgetUsd <= 0) {
          continue;
        }
        const rebuilt = await this.buildCandidate(
          evaluation.snapshot,
          evaluation.fairValue,
          riskState,
          activeOrders,
          undefined,
          weightedBudgetUsd,
        );
        if (!rebuilt.candidate) {
          continue;
        }
        executableCandidate = rebuilt.candidate;
      }
      const action = await this.executeCandidate(executableCandidate, snapshot, position, positions, activeOrders);
      if (action) {
        actions.push(action);
      }
    }
    return actions;
  }

  private async handleExits(
    evaluations: MarketEvaluation[],
    positions: OpenPosition[],
    activeOrders: ExecutionRecord[],
  ): Promise<CycleAction[]> {
    const actions: CycleAction[] = [];
    const exitCandidates = evaluations
      .map((evaluation) => ({
        candidate: evaluation.candidate,
        snapshot: evaluation.snapshot,
      }))
      .filter((entry): entry is { candidate: TradeCandidate; snapshot: MarketSnapshot } => Boolean(entry.candidate))
      .filter((entry) => entry.candidate.action === "EXIT");

    for (const { candidate, snapshot } of exitCandidates) {
      const position = positions.find((row) => row.marketId === candidate.marketId && row.status === "OPEN");
      if (!position) {
        continue;
      }
      const action = await this.executeCandidate(candidate, snapshot, position, positions, activeOrders);
      if (action) {
        actions.push(action);
      }
    }
    return actions;
  }

  private async executeCandidate(
    candidate: TradeCandidate,
    snapshot: MarketSnapshot | undefined,
    position: OpenPosition | undefined,
    positions: OpenPosition[],
    activeOrders: ExecutionRecord[],
  ): Promise<CycleAction | undefined> {
    if (!snapshot) {
      return undefined;
    }

    let execution: ExecutionRecord;
    try {
      execution = await this.broker.execute(candidate, position);
    } catch (error) {
      const rejectedExecution: ExecutionRecord = {
        clientOrderId: `rejected-${Date.now()}-${candidate.marketId}`,
        mode: this.config.mode,
        candidate,
        status: "REJECTED",
        fillApr: candidate.orderApr,
        executedAt: Math.floor(Date.now() / 1000),
        requestedSizeBase18: candidate.sizeBase18.toString(),
        filledSizeBase18: "0",
        remainingSizeBase18: candidate.sizeBase18.toString(),
        appliedSizeBase18: "0",
        lastReconciledAt: Math.floor(Date.now() / 1000),
        notes: error instanceof Error ? error.message : String(error),
      };
      this.store.saveOrder(rejectedExecution);
      this.store.setRuntimeValue("last_execution_error", {
        at: rejectedExecution.executedAt,
        marketId: candidate.marketId,
        action: candidate.action,
        side: candidate.side,
        message: rejectedExecution.notes,
      });
      if (candidate.isIsolatedOnly && candidate.action !== "EXIT") {
        const sweepNotes = await this.broker.sweepIsolatedCash([{ marketId: candidate.marketId, tokenId: candidate.tokenId }]);
        if (sweepNotes.length > 0) {
          this.store.setRuntimeValue("last_isolated_sweeps", sweepNotes);
        }
      }
      return undefined;
    }

    this.store.saveOrder(execution);
    const appliedExecution = this.applyOrderExecution(execution, positions, new Map([[snapshot.market.marketId, snapshot]]));
    this.store.saveOrder(appliedExecution);
    this.updateActiveOrders(activeOrders, appliedExecution);
    if (
      candidate.isIsolatedOnly &&
      candidate.action !== "EXIT" &&
      (appliedExecution.status === "CANCELLED" || appliedExecution.status === "REJECTED") &&
      appliedExecution.filledSizeBase18 === "0"
    ) {
      const sweepNotes = await this.broker.sweepIsolatedCash([{ marketId: candidate.marketId, tokenId: candidate.tokenId }]);
      if (sweepNotes.length > 0) {
        this.store.setRuntimeValue("last_isolated_sweeps", sweepNotes);
      }
    }

    return {
      marketId: candidate.marketId,
      marketName: snapshot.market.name,
      side: candidate.side,
      action: candidate.action,
      label: this.describeCycleAction(candidate.action, appliedExecution),
      intent: candidate.orderIntent,
      orderStatus: appliedExecution.status,
      fillApr: appliedExecution.fillApr,
      netEdgeBps: candidate.netEdgeBps,
    };
  }

  private describeCycleAction(action: ActionType, execution: ExecutionRecord): string {
    const filledSizeBase18 = BigInt(execution.filledSizeBase18);
    if (filledSizeBase18 === 0n) {
      if (execution.status === "OPEN" || execution.status === "SUBMITTED") {
        return action === "EXIT" ? "PLACE_EXIT_ORDER" : "PLACE_ORDER";
      }
      if (execution.status === "PARTIALLY_FILLED") {
        return action === "EXIT" ? "PARTIAL_EXIT" : "PARTIAL_ENTRY";
      }
      return execution.status;
    }

    if (execution.status === "PARTIALLY_FILLED") {
      return action === "EXIT" ? "PARTIAL_EXIT" : "PARTIAL_ENTRY";
    }

    return action;
  }

  private buildCycleSummary(params: {
    fetchedMarkets: number;
    eligibleMarkets: number;
    snapshots: MarketSnapshot[];
    snapshotErrors: string[];
    evaluations: MarketEvaluation[];
    actions: CycleAction[];
    openPositions: OpenPosition[];
    killSwitchActive: boolean;
  }): CycleSummary {
    const skipCounts = new Map<string, number>();
    for (const evaluation of params.evaluations) {
      if (!evaluation.reasonSkipped) {
        continue;
      }
      skipCounts.set(evaluation.reasonSkipped, (skipCounts.get(evaluation.reasonSkipped) ?? 0) + 1);
    }

    const topEdges = params.evaluations
      .map((evaluation) => {
        const longEdge = evaluation.fairValue.edgeBpsLong;
        const shortEdge = evaluation.fairValue.edgeBpsShort;
        const side: TradeSide = longEdge >= shortEdge ? "LONG" : "SHORT";
        const edgeBps = side === "LONG" ? longEdge : shortEdge;
        return {
          marketId: evaluation.snapshot.market.marketId,
          marketName: evaluation.snapshot.market.name,
          side,
          action: evaluation.candidate?.action,
          edgeBps,
          netEdgeBps: evaluation.candidate?.netEdgeBps,
          fairApr: evaluation.fairValue.fairApr,
          midApr: evaluation.snapshot.market.midApr,
          reason: evaluation.reasonSkipped,
        };
      })
      .sort((left, right) => (right.netEdgeBps ?? right.edgeBps) - (left.netEdgeBps ?? left.edgeBps))
      .slice(0, 5);

    return {
      fetchedMarkets: params.fetchedMarkets,
      eligibleMarkets: params.eligibleMarkets,
      snapshotMarkets: params.snapshots.length,
      snapshotErrors: params.snapshotErrors,
      openPositions: params.openPositions.filter((position) => position.status === "OPEN").length,
      killSwitchActive: params.killSwitchActive,
      topEdges,
      skipReasonCounts: [...skipCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count),
      actions: params.actions,
    };
  }

  private buildForcedExitCandidate(
    snapshot: MarketSnapshot,
    targetApr: number,
    existingPosition: OpenPosition,
    side: TradeSide,
    edgeBps: number,
    status: string,
    rationale: string,
    raw: Record<string, number>,
  ): { candidate: TradeCandidate } {
    return {
      candidate: {
        marketId: snapshot.market.marketId,
        tokenId: snapshot.market.tokenId,
        isIsolatedOnly: snapshot.market.isIsolatedOnly,
        side,
        action: "EXIT",
        orderIntent: "taker",
        edgeBps,
        netEdgeBps: edgeBps,
        targetApr,
        orderTick: this.selectOrderTick(snapshot, side, "taker"),
        orderApr: this.selectOrderApr(snapshot, side, "taker"),
        sizeBase: existingPosition.sizeBase,
        sizeBase18: BigInt(existingPosition.sizeBase18),
        notionalUsd: existingPosition.notionalUsd,
        plannedMarginUsd: existingPosition.initialMarginUsd,
        simulation: {
          marginRequiredUsd: existingPosition.initialMarginUsd,
          actualLeverage: existingPosition.actualLeverage,
          liquidationApr: existingPosition.liquidationApr,
          liquidationBufferBps: existingPosition.liquidationBufferBps,
          priceImpactBps: 0,
          feeBps: 0,
          status,
          raw,
        },
        rationale,
      },
    };
  }

  private normalizeDailyBaseline(storedBaseline: number | undefined, openPositions: OpenPosition[]): number {
    if (storedBaseline === undefined) {
      return this.config.startingEquityUsd;
    }

    if (openPositions.length === 0) {
      const ratio = storedBaseline / this.config.startingEquityUsd;
      if (ratio > 1.5 || ratio < 0.5) {
        return this.config.startingEquityUsd;
      }
    }

    return storedBaseline;
  }

  private normalizeOrderTick(
    tick: number,
    tickStep: number,
    side: TradeSide,
    orderIntent: "maker" | "taker",
  ): number {
    if (tickStep <= 1) {
      return tick;
    }

    const remainder = ((tick % tickStep) + tickStep) % tickStep;
    if (remainder === 0) {
      return tick;
    }

    const lower = tick - remainder;
    const upper = lower + tickStep;

    if (orderIntent === "maker") {
      return side === "LONG" ? lower : upper;
    }
    return side === "LONG" ? upper : lower;
  }

  private weightedAverageApr(
    existingNotionalUsd: number,
    existingApr: number,
    addedNotionalUsd: number,
    addedApr: number,
  ): number {
    const total = existingNotionalUsd + addedNotionalUsd;
    if (total <= 0) {
      return existingApr;
    }
    return ((existingNotionalUsd * existingApr) + (addedNotionalUsd * addedApr)) / total;
  }

  private async prepareExecutableOrder(params: {
    action: "ENTER" | "EXIT" | "ADD";
    edgeBps: number;
    marginBudgetUsd: number;
    maxLiquiditySizeBase: number;
    orderIntent: "maker" | "taker";
    marketId: number;
    side: TradeSide;
    sizeBase: number;
    snapshot: MarketSnapshot;
  }): Promise<{
    sizeBase: number;
    sizeBase18: bigint;
    orderIntent: "maker" | "taker";
    orderApr: number;
    orderTick?: number;
    simulation: Awaited<ReturnType<BorosApiClient["simulateOrder"]>>;
  }> {
    let sizeBase = params.sizeBase;
    let orderIntent = params.orderIntent;

    for (let attempt = 0; attempt < MAX_EXECUTION_RETRIES; attempt += 1) {
      const sizeBase18 = sizeAsBase18(sizeBase);
      if (sizeBase18 <= 0n) {
        break;
      }

      const orderApr = this.selectOrderApr(params.snapshot, params.side, orderIntent);
      const rawTick = this.selectOrderTick(params.snapshot, params.side, orderIntent);
      const orderTick = rawTick === undefined
        ? undefined
        : this.normalizeOrderTick(rawTick, params.snapshot.market.tickStep, params.side, orderIntent);
      const tif = orderIntent === "maker" ? MAKER_TIF : TAKER_TIF;
      const slippage = orderIntent === "maker" ? undefined : this.config.marketOrderSlippage;

      try {
        const simulation = await this.api.simulateOrder({
          marketId: params.marketId,
          side: params.side,
          sizeBase18,
          limitTick: orderTick,
          tif,
          slippage,
        });
        if (params.action !== "EXIT") {
          const resized = this.adjustSizeTowardMarginTarget({
            currentSizeBase: sizeBase,
            currentMarginUsd: simulation.marginRequiredUsd,
            marginBudgetUsd: params.marginBudgetUsd,
            maxLiquiditySizeBase: params.maxLiquiditySizeBase,
          });
          if (resized !== undefined) {
            sizeBase = resized;
            continue;
          }
        }
        return {
          sizeBase,
          sizeBase18,
          orderIntent,
          orderApr,
          orderTick,
          simulation,
        };
      } catch (error) {
        if (error instanceof BorosApiError) {
          if (error.errorCode === "TRADE_ALOAMM_NOT_ALLOWED" && orderIntent === "maker") {
            orderIntent = "taker";
            continue;
          }

          if (error.errorCode === "ORDER_VALUE_TOO_LOW" && params.action !== "EXIT") {
            const nextSizeBase = this.nextExecutionSize(sizeBase, params.maxLiquiditySizeBase);
            if (nextSizeBase !== undefined) {
              sizeBase = nextSizeBase;
              continue;
            }
            throw new Error("minimum executable order value exceeds liquidity budget");
          }

          throw new Error(`simulation request failed: ${error.message}`);
        }

        throw error;
      }
    }

    throw new Error("unable to find executable order within Boros market constraints");
  }

  private nextExecutionSize(currentSizeBase: number, maxLiquiditySizeBase: number): number | undefined {
    if (maxLiquiditySizeBase <= currentSizeBase) {
      return undefined;
    }

    const nextSizeBase = Math.min(maxLiquiditySizeBase, currentSizeBase * 2);
    if (nextSizeBase <= currentSizeBase) {
      return undefined;
    }

    return nextSizeBase;
  }

  private adjustSizeTowardMarginTarget(params: {
    currentSizeBase: number;
    currentMarginUsd: number;
    marginBudgetUsd: number;
    maxLiquiditySizeBase: number;
  }): number | undefined {
    const {
      currentSizeBase,
      currentMarginUsd,
      marginBudgetUsd,
      maxLiquiditySizeBase,
    } = params;

    if (currentSizeBase <= 0 || currentMarginUsd <= 0 || marginBudgetUsd <= 0) {
      return undefined;
    }

    const cappedBudgetUsd = Math.max(0, marginBudgetUsd);
    const targetMarginUsd = cappedBudgetUsd * this.config.marginUtilizationTargetPct;

    if (currentMarginUsd > cappedBudgetUsd * 1.02) {
      const nextSizeBase = currentSizeBase * (cappedBudgetUsd / currentMarginUsd) * 0.99;
      if (nextSizeBase < currentSizeBase * 0.95) {
        return Math.max(0, nextSizeBase);
      }
      return undefined;
    }

    if (currentMarginUsd >= targetMarginUsd) {
      return undefined;
    }

    const nextSizeBase = Math.min(
      maxLiquiditySizeBase,
      currentSizeBase * (targetMarginUsd / currentMarginUsd),
    );

    if (nextSizeBase > currentSizeBase * 1.05) {
      return nextSizeBase;
    }

    return undefined;
  }

  private selectOrderApr(snapshot: MarketSnapshot, side: TradeSide, orderIntent: "maker" | "taker"): number {
    if (orderIntent === "maker") {
      return side === "LONG" ? snapshot.market.bestBid : snapshot.market.bestAsk;
    }
    return side === "LONG" ? snapshot.market.bestAsk : snapshot.market.bestBid;
  }

  private selectOrderTick(snapshot: MarketSnapshot, side: TradeSide, orderIntent: "maker" | "taker"): number | undefined {
    if (orderIntent === "maker") {
      return side === "LONG" ? snapshot.orderBook.bestLongTick : snapshot.orderBook.bestShortTick;
    }
    return side === "LONG" ? snapshot.orderBook.bestShortTick : snapshot.orderBook.bestLongTick;
  }

  private isOrderActive(order: ExecutionRecord): boolean {
    return order.status === "SUBMITTED" || order.status === "OPEN" || order.status === "PARTIALLY_FILLED";
  }

  private updateActiveOrders(activeOrders: ExecutionRecord[], updatedOrder: ExecutionRecord): void {
    const existingIndex = activeOrders.findIndex((order) => order.clientOrderId === updatedOrder.clientOrderId);
    if (this.isOrderActive(updatedOrder)) {
      if (existingIndex >= 0) {
        activeOrders[existingIndex] = updatedOrder;
      } else {
        activeOrders.push(updatedOrder);
      }
      return;
    }

    if (existingIndex >= 0) {
      activeOrders.splice(existingIndex, 1);
    }
  }

  private async cancelStaleLiveOrders(activeOrders: ExecutionRecord[]): Promise<ExecutionRecord[]> {
    const now = Math.floor(Date.now() / 1000);
    const staleOrders = activeOrders.filter((order) => {
      if (order.candidate.orderIntent !== "maker") {
        return false;
      }
      const ttl = order.candidate.action === "EXIT"
        ? this.config.liveExitOrderTtlSeconds
        : this.config.liveEntryOrderTtlSeconds;
      return (now - order.executedAt) >= ttl;
    });

    const cancelled: ExecutionRecord[] = [];
    for (const order of staleOrders) {
      const updated = await this.broker.cancel(order, `Auto-cancelled stale order after ${now - order.executedAt}s`);
      cancelled.push(updated);
    }

    if (cancelled.length > 0) {
      this.store.setRuntimeValue(
        "last_cancelled_live_orders",
        cancelled.map((order) => ({
          clientOrderId: order.clientOrderId,
          marketId: order.candidate.marketId,
          externalOrderId: order.externalOrderId,
          status: order.status,
        })),
      );
    }
    return cancelled;
  }

  private applyOrderExecution(
    order: ExecutionRecord,
    positions: OpenPosition[],
    snapshots: Map<number, MarketSnapshot>,
  ): ExecutionRecord {
    const filledSizeBase18 = BigInt(order.filledSizeBase18);
    const appliedSizeBase18 = BigInt(order.appliedSizeBase18);
    const deltaFilledBase18 = filledSizeBase18 - appliedSizeBase18;

    if (deltaFilledBase18 <= 0n) {
      return order;
    }

    const snapshot = snapshots.get(order.candidate.marketId);
    const existingIndex = positions.findIndex((position) => position.marketId === order.candidate.marketId && position.status === "OPEN");
    const existingPosition = existingIndex >= 0 ? positions[existingIndex] : undefined;
    const deltaSizeBase = fromBase18(deltaFilledBase18);
    const fillRatio = order.candidate.sizeBase <= 0
      ? 0
      : Math.min(1, deltaSizeBase / order.candidate.sizeBase);
    const now = order.lastReconciledAt || order.executedAt;

    if (order.candidate.action === "EXIT") {
      if (existingPosition) {
        const exitRatio = existingPosition.sizeBase <= 0
          ? 1
          : Math.min(1, deltaSizeBase / existingPosition.sizeBase);
        const remainingRatio = Math.max(0, 1 - exitRatio);
        const nextSizeBase18 = BigInt(existingPosition.sizeBase18) - deltaFilledBase18;

        if (nextSizeBase18 <= 0n || remainingRatio <= 1e-9) {
          const closedPosition: OpenPosition = {
            ...existingPosition,
            marketAcc: order.marketAcc ?? existingPosition.marketAcc,
            status: "CLOSED",
            closedAt: now,
            currentApr: order.fillApr,
            floatingApr: snapshot?.market.floatingApr ?? existingPosition.floatingApr,
            assetMarkPrice: snapshot?.market.assetMarkPrice ?? existingPosition.assetMarkPrice,
        realizedTradingPnlUsd: existingPosition.realizedTradingPnlUsd + existingPosition.unrealizedPnlUsd,
        unrealizedPnlUsd: 0,
        peakPnlUsd: existingPosition.peakPnlUsd,
        peakPnlPct: existingPosition.peakPnlPct,
        lastAccrualTs: now,
      };
          positions[existingIndex] = closedPosition;
          this.store.upsertPosition(closedPosition);
        } else {
          const reducedPosition: OpenPosition = {
            ...existingPosition,
            marketAcc: order.marketAcc ?? existingPosition.marketAcc,
            currentApr: order.fillApr,
            floatingApr: snapshot?.market.floatingApr ?? existingPosition.floatingApr,
            sizeBase: existingPosition.sizeBase * remainingRatio,
            sizeBase18: nextSizeBase18.toString(),
            assetMarkPrice: snapshot?.market.assetMarkPrice ?? existingPosition.assetMarkPrice,
            notionalUsd: existingPosition.notionalUsd * remainingRatio,
            initialMarginUsd: existingPosition.initialMarginUsd * remainingRatio,
            realizedTradingPnlUsd: existingPosition.realizedTradingPnlUsd + (existingPosition.unrealizedPnlUsd * exitRatio),
            unrealizedPnlUsd: existingPosition.unrealizedPnlUsd * remainingRatio,
            peakPnlUsd: existingPosition.peakPnlUsd,
            peakPnlPct: existingPosition.peakPnlPct,
            lastAccrualTs: now,
          };
          positions[existingIndex] = reducedPosition;
          this.store.upsertPosition(reducedPosition);
        }
      }

      return {
        ...order,
        appliedSizeBase18: filledSizeBase18.toString(),
        lastReconciledAt: now,
      };
    }

    const addedNotionalUsd = order.candidate.notionalUsd * fillRatio;
    const addedMarginUsd = order.candidate.plannedMarginUsd * fillRatio;
    if (existingPosition) {
      const updatedPosition: OpenPosition = {
        ...existingPosition,
        tokenId: order.candidate.tokenId,
        marketAcc: order.marketAcc ?? existingPosition.marketAcc,
        entryApr: this.weightedAverageApr(existingPosition.notionalUsd, existingPosition.entryApr, addedNotionalUsd, order.fillApr),
        fixedApr: this.weightedAverageApr(existingPosition.notionalUsd, existingPosition.fixedApr, addedNotionalUsd, order.fillApr),
        sizeBase: existingPosition.sizeBase + deltaSizeBase,
        sizeBase18: (BigInt(existingPosition.sizeBase18) + deltaFilledBase18).toString(),
        notionalUsd: existingPosition.notionalUsd + addedNotionalUsd,
        initialMarginUsd: existingPosition.initialMarginUsd + addedMarginUsd,
        addCount: order.candidate.action === "ADD" ? existingPosition.addCount + 1 : existingPosition.addCount,
        currentApr: order.fillApr,
        floatingApr: snapshot?.market.floatingApr ?? existingPosition.floatingApr,
        assetMarkPrice: snapshot?.market.assetMarkPrice ?? existingPosition.assetMarkPrice,
        actualLeverage: order.candidate.simulation.actualLeverage,
        liquidationApr: order.candidate.simulation.liquidationApr,
        liquidationBufferBps: order.candidate.simulation.liquidationBufferBps,
        lastSignalEdgeBps: order.candidate.edgeBps,
      };
      positions[existingIndex] = updatedPosition;
      this.store.upsertPosition(updatedPosition);
    } else {
      const assetMarkPrice = snapshot?.market.assetMarkPrice ?? 0;
      const newPosition: OpenPosition = {
        id: makePositionId(order.candidate.marketId, now, order.candidate.side),
        marketId: order.candidate.marketId,
        tokenId: order.candidate.tokenId,
        marketName: snapshot?.market.name ?? `Market ${order.candidate.marketId}`,
        assetSymbol: snapshot?.market.assetSymbol ?? "UNKNOWN",
        isIsolatedOnly: order.candidate.isIsolatedOnly,
        marketAcc: order.marketAcc,
        side: order.candidate.side,
        status: "OPEN",
        openedAt: now,
        entryApr: order.fillApr,
        currentApr: order.fillApr,
        fixedApr: order.fillApr,
        floatingApr: snapshot?.market.floatingApr ?? order.candidate.targetApr,
        sizeBase: deltaSizeBase,
        sizeBase18: deltaFilledBase18.toString(),
        assetMarkPrice,
        notionalUsd: addedNotionalUsd,
        initialMarginUsd: addedMarginUsd,
        actualLeverage: order.candidate.simulation.actualLeverage,
        liquidationApr: order.candidate.simulation.liquidationApr,
        liquidationBufferBps: order.candidate.simulation.liquidationBufferBps,
        addCount: 0,
        realizedCarryPnlUsd: 0,
        realizedTradingPnlUsd: 0,
        unrealizedPnlUsd: 0,
        peakPnlUsd: 0,
        peakPnlPct: 0,
        lastAccrualTs: now,
        lastSignalEdgeBps: order.candidate.edgeBps,
      };
      positions.push(newPosition);
      this.store.upsertPosition(newPosition);
    }

    return {
      ...order,
      appliedSizeBase18: filledSizeBase18.toString(),
      lastReconciledAt: now,
    };
  }

  private async sweepClosedIsolatedCash(positions: OpenPosition[], activeOrders: ExecutionRecord[]): Promise<string[]> {
    const openPositionKeys = new Set(
      positions
        .filter((position) => position.status === "OPEN")
        .map((position) => `${position.tokenId}:${position.marketId}`),
    );
    const activeOrderKeys = new Set(activeOrders.map((order) => `${order.candidate.tokenId}:${order.candidate.marketId}`));
    const marketsToSweep = positions
      .filter((position) => position.isIsolatedOnly)
      .filter((position) => !openPositionKeys.has(`${position.tokenId}:${position.marketId}`))
      .filter((position) => !activeOrderKeys.has(`${position.tokenId}:${position.marketId}`))
      .map((position) => ({ marketId: position.marketId, tokenId: position.tokenId }));

    return this.broker.sweepIsolatedCash(marketsToSweep);
  }
}
