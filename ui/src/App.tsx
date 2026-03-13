import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { usePolling } from "./hooks/usePolling";
import type {
  MarketsResponse, PositionRow, OrderRow, SignalRow, KillEventRow,
  AppState, RiskState, CopyPositionRow, CopyTradeRow, CopyTargetRow,
  AccountSummary, OnChainPositionsResponse, AppTab,
} from "./types";
import Header from "./components/Header";
import MarketGrid from "./components/MarketGrid";
import EdgeScanner from "./components/EdgeScanner";
import ActivityLog from "./components/ActivityLog";
import SettingsDrawer from "./components/SettingsDrawer";
import CopyPositions from "./components/CopyPositions";
import CopyTrades from "./components/CopyTrades";
import RiskPanel from "./components/RiskPanel";
import CopyRiskPanel from "./components/CopyRiskPanel";
import BotStatus from "./components/BotStatus";
import TargetTracker from "./components/TargetTracker";
import OnChainPositions from "./components/OnChainPositions";
import AgentMode from "./components/AgentMode";
import WalletLookup from "./components/WalletLookup";

const POLL_FAST = 5_000;
const POLL_SLOW = 10_000;

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<AppTab>("strategy");
  const [logHeight, setLogHeight] = useState(110);
  const dragging = useRef(false);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startY = e.clientY;
    const startH = logHeight;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startY - ev.clientY;
      setLogHeight(Math.max(60, Math.min(window.innerHeight * 0.6, startH + delta)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [logHeight]);

  const markets = usePolling<MarketsResponse>("/api/markets", POLL_FAST);
  const positions = usePolling<PositionRow[]>("/api/positions", POLL_SLOW);
  const orders = usePolling<OrderRow[]>("/api/orders", POLL_SLOW);
  const signals = usePolling<SignalRow[]>("/api/signals", POLL_SLOW);
  const killEvents = usePolling<KillEventRow[]>("/api/kill-events", POLL_SLOW);
  const appState = usePolling<AppState>("/api/state", POLL_SLOW);

  // Copy trade data
  const copyPositions = usePolling<CopyPositionRow[]>("/api/copy-positions", POLL_FAST);
  const copyTrades = usePolling<CopyTradeRow[]>("/api/copy-trades", POLL_SLOW);
  const copyTargets = usePolling<CopyTargetRow[]>("/api/copy-targets", POLL_SLOW);

  // On-chain account data from Boros API
  const account = usePolling<AccountSummary>("/api/account", POLL_SLOW);

  // On-chain positions from Boros API
  const onChainPositions = usePolling<OnChainPositionsResponse>("/api/account/positions", POLL_FAST);

  const isCopyMode = appState.data?.copyTradeEnabled ||
    (copyPositions.data && copyPositions.data.length > 0) ||
    (copyTrades.data && copyTrades.data.length > 0);

  // Auto-sync tab to copy on initial load if copy mode is active
  const initialTabSynced = useRef(false);
  useEffect(() => {
    if (isCopyMode && !initialTabSynced.current) {
      initialTabSynced.current = true;
      setActiveTab("copy");
    }
  }, [isCopyMode]);

  // Build risk state: prefer on-chain account data, fall back to bot's internal state
  const botRiskState = (appState.data?.runtimeState?.risk_state as RiskState) ?? null;
  const riskState = useMemo<RiskState | null>(() => {
    const acct = account.data;
    if (acct && acct.equity > 0) {
      const dailyPnl = acct.startDayEquity > 0
        ? (acct.equity - acct.startDayEquity) / acct.startDayEquity
        : botRiskState?.dailyPnlPct ?? 0;
      return {
        equityUsd: acct.equity,
        usedInitialMarginUsd: acct.initialMarginUsed,
        dailyPnlPct: dailyPnl,
        failureStreak: botRiskState?.failureStreak ?? 0,
        killSwitchActive: botRiskState?.killSwitchActive ?? false,
      };
    }
    return botRiskState;
  }, [account.data, botRiskState]);

  // Keyboard shortcuts: 1=Strategy, 2=Copy, 3=Wallet, 4=Agent, s=Settings, Escape=close settings
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      switch (e.key) {
        case "1": setActiveTab("strategy"); break;
        case "2": setActiveTab("copy"); break;
        case "3": setActiveTab("wallet"); break;
        case "4": setActiveTab("agent"); break;
        case "s": setSettingsOpen(prev => !prev); break;
        case "Escape": setSettingsOpen(false); break;
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Connection status — detect when server is fully unreachable
  const isServerDown = useMemo(() => {
    const errors = [markets.error, positions.error, appState.error];
    const hasAnyData = markets.data || positions.data || appState.data;
    return errors.filter(Boolean).length >= 3 && !hasAnyData;
  }, [markets.error, positions.error, appState.error, markets.data, positions.data, appState.data]);

  // Kill switch browser notification
  const prevKillRef = useRef(false);
  useEffect(() => {
    const killActive = appState.data?.killSwitchActive ?? false;
    if (killActive && !prevKillRef.current) {
      if ("Notification" in window) {
        if (Notification.permission === "granted") {
          new Notification("Boros Kill Switch Activated", {
            body: "Trading has been halted. Check the dashboard for details.",
            icon: "/favicon.ico",
          });
        } else if (Notification.permission !== "denied") {
          Notification.requestPermission();
        }
      }
    }
    prevKillRef.current = killActive;
  }, [appState.data?.killSwitchActive]);

  // Dynamic page title
  useEffect(() => {
    const posCount = onChainPositions.data?.positions?.length ?? 0;
    const eq = riskState?.equityUsd;
    const parts = ["Boros"];
    if (posCount > 0) parts.push(`${posCount} pos`);
    if (eq && eq > 0) parts.push(`$${eq.toFixed(0)}`);
    document.title = parts.join(" | ");
  }, [onChainPositions.data?.positions?.length, riskState?.equityUsd]);

  // Compute latest refresh across all polling hooks
  const lastRefresh = useMemo(() => {
    const times = [
      markets.lastUpdated, positions.lastUpdated, orders.lastUpdated,
      signals.lastUpdated, killEvents.lastUpdated, appState.lastUpdated,
      copyPositions.lastUpdated, copyTrades.lastUpdated, copyTargets.lastUpdated,
      account.lastUpdated, onChainPositions.lastUpdated,
    ].filter((t): t is number => t != null);
    return times.length > 0 ? Math.max(...times) : null;
  }, [
    markets.lastUpdated, positions.lastUpdated, orders.lastUpdated,
    signals.lastUpdated, killEvents.lastUpdated, appState.lastUpdated,
    copyPositions.lastUpdated, copyTrades.lastUpdated, copyTargets.lastUpdated,
    account.lastUpdated, onChainPositions.lastUpdated,
  ]);

  return (
    <div className="grid h-screen overflow-hidden bg-background" style={{ gridTemplateRows: `auto 1fr ${logHeight}px` }}>
      <Header
        state={appState.data}
        markets={markets.data}
        onOpenSettings={() => setSettingsOpen(true)}
        isCopyMode={!!isCopyMode}
        copyPositionCount={copyPositions.data?.length ?? 0}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        lastRefresh={lastRefresh}
        equityUsd={riskState?.equityUsd ?? null}
      />

      <div className="flex flex-col overflow-hidden">
        {isServerDown && (
          <div className="bg-red/20 border-b border-red/40 text-red text-[11px] font-semibold tracking-wide text-center py-1.5 shrink-0">
            Server offline — retrying connection...
          </div>
        )}

        {appState.data?.killSwitchActive && (
          <div className="bg-red/20 border-b border-red/40 text-red text-[11px] font-semibold tracking-wide text-center py-1.5 animate-pulse shrink-0">
            Kill switch active — trading halted
          </div>
        )}

        {activeTab === "strategy" ? (
          <div className="grid gap-0.5 p-0.5 overflow-hidden flex-1 grid-cols-[2fr_1fr_360px] grid-rows-[3fr_2fr]">
            <MarketGrid
              markets={markets.data}
              loading={markets.loading}
              lastUpdated={markets.lastUpdated}
              error={markets.error}
              stale={markets.stale}
              signals={signals.data}
              positionMarketIds={onChainPositions.data?.positions?.map(p => p.marketId) ?? null}
            />
            <OnChainPositions
              positions={onChainPositions.data?.positions ?? null}
              markets={markets.data}
              loading={onChainPositions.loading}
              lastUpdated={onChainPositions.lastUpdated}
              error={onChainPositions.data?.error ?? onChainPositions.error}
              stale={onChainPositions.stale}
            />
            <RiskPanel
              className="row-span-2"
              riskState={riskState}
              positions={positions.data}
              signals={signals.data}
              availableBalance={account.data?.availableBalance}
            />
            <EdgeScanner
              signals={signals.data}
              loading={signals.loading}
              lastUpdated={signals.lastUpdated}
              error={signals.error}
              stale={signals.stale}
              markets={markets.data}
            />
            <BotStatus
              appState={appState.data}
              lastUpdated={lastRefresh}
              signals={signals.data}
              orders={orders.data}
            />
          </div>
        ) : activeTab === "copy" ? (
          <div className="grid gap-0.5 p-0.5 overflow-hidden flex-1 grid-cols-[2fr_1fr_360px] grid-rows-[3fr_2fr]">
            <MarketGrid
              markets={markets.data}
              loading={markets.loading}
              lastUpdated={markets.lastUpdated}
              error={markets.error}
              stale={markets.stale}
            />
            <CopyPositions
              positions={copyPositions.data}
              loading={copyPositions.loading}
              lastUpdated={copyPositions.lastUpdated}
              error={copyPositions.error}
              stale={copyPositions.stale}
              markets={markets.data}
            />
            <CopyRiskPanel
              className="row-span-2"
              riskState={riskState}
              copyPositions={copyPositions.data}
              copyTargets={copyTargets.data}
              copyTrades={copyTrades.data}
            />
            <CopyTrades
              trades={copyTrades.data}
              loading={copyTrades.loading}
              lastUpdated={copyTrades.lastUpdated}
              error={copyTrades.error}
              stale={copyTrades.stale}
            />
            <TargetTracker
              markets={markets.data}
            />
          </div>
        ) : activeTab === "wallet" ? (
          <div className="p-0.5 overflow-hidden flex-1">
            <WalletLookup markets={markets.data} />
          </div>
        ) : null}
        {/* Keep AgentMode always mounted so polling state survives tab switches */}
        <div className={activeTab === "agent" ? "flex flex-col overflow-hidden flex-1" : "hidden"}>
          <AgentMode
            markets={markets.data}
            account={account.data}
            onChainPositions={onChainPositions.data}
            onChainLoading={onChainPositions.loading}
            onChainUpdated={onChainPositions.lastUpdated}
            onChainError={onChainPositions.data?.error ?? onChainPositions.error}
            onChainStale={onChainPositions.stale}
            riskState={riskState}
          />
        </div>
      </div>

      <div className="overflow-hidden flex flex-col">
        <div
          className="h-1 cursor-row-resize bg-border/40 hover:bg-coral/40 transition-colors shrink-0"
          onMouseDown={onDragStart}
        />
        <ActivityLog
          orders={orders.data}
          killEvents={killEvents.data}
          copyTrades={isCopyMode ? copyTrades.data : null}
          loading={orders.loading}
        />
      </div>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
