import { useMemo } from "react";
import type { AppState, SignalRow, OrderRow } from "../types";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";

interface BotStatusProps {
  appState: AppState | null;
  lastUpdated: number | null;
  signals: SignalRow[] | null;
  orders: OrderRow[] | null;
}

/* ── helpers ── */

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function timeAgo(ts: number): string {
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "just now";
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

/* ── row layout ── */

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-1 border-b border-border/20">
      <span className="text-[11px] tracking-wide text-text-muted">
        {label}
      </span>
      <span className="text-[13px] font-mono">{children}</span>
    </div>
  );
}

/* ── component ── */

export default function BotStatus({
  appState,
  lastUpdated,
  signals,
  orders,
}: BotStatusProps) {
  /* heartbeat */
  const isStale =
    lastUpdated !== null && Date.now() - lastUpdated > 30_000;

  const heartbeatDisplay = lastUpdated !== null ? formatTime(lastUpdated) : "--";

  /* strategy mode */
  const mode = appState?.mode ?? "unknown";

  /* kill switch */
  const killActive = appState?.killSwitchActive ?? false;

  /* recent error */
  const lastError = useMemo(() => {
    const raw = appState?.runtimeState?.last_error;
    if (!raw || typeof raw !== "object") return null;
    const err = raw as { code?: string; message?: string; timestamp?: number };
    if (!err.message && !err.code) return null;
    return err;
  }, [appState?.runtimeState?.last_error]);

  /* failure streak */
  const failureStreak =
    (appState?.runtimeState?.risk_state as any)?.failureStreak ?? 0;

  /* counts */
  const openOrders = useMemo(() => {
    if (!orders) return 0;
    return orders.filter(o => {
      const s = o.status.toUpperCase();
      return s === "PENDING" || s === "OPEN" || s === "PARTIAL";
    }).length;
  }, [orders]);
  const recentOrders = orders?.length ?? 0;
  const signalsEvaluated = signals?.length ?? 0;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Bot Status</CardTitle>
      </CardHeader>
      <CardContent className="px-3 py-1.5 space-y-0">
        {/* Heartbeat */}
        <Row label="Heartbeat">
          <span className={isStale ? "text-amber" : "text-text-secondary"}>
            {heartbeatDisplay}
          </span>
        </Row>

        {/* Strategy Mode */}
        <Row label="Strategy Mode">
          <Badge variant={mode === "live" ? "live" : "paper"}>
            {mode.toUpperCase()}
          </Badge>
        </Row>

        {/* Kill Switch */}
        <Row label="Kill Switch">
          {killActive ? (
            <Badge variant="short" className="bg-red/20 text-red font-bold">
              ACTIVE
            </Badge>
          ) : (
            <Badge variant="long">OK</Badge>
          )}
        </Row>

        {/* Recent Error */}
        <Row label="Recent Error">
          {lastError ? (
            <span className="text-coral truncate max-w-[180px] inline-block text-right">
              {lastError.code && (
                <span className="text-red">{lastError.code} </span>
              )}
              {lastError.message}
              {lastError.timestamp != null && (
                <span className="text-text-muted ml-1">
                  {timeAgo(lastError.timestamp)}
                </span>
              )}
            </span>
          ) : (
            <span className="text-text-muted">None</span>
          )}
        </Row>

        {/* Failure Streak */}
        <Row label="Failure Streak">
          <span className={failureStreak > 0 ? "text-red" : "text-text-muted"}>
            {failureStreak}
          </span>
        </Row>

        {/* Open Orders */}
        <Row label="Open Orders">
          <span className={openOrders > 0 ? "text-amber" : "text-text-secondary"}>{openOrders}</span>
        </Row>

        {/* Recent Orders */}
        <Row label="Recent Orders">
          <span className="text-text-secondary">{recentOrders}</span>
        </Row>

        {/* Signals Evaluated */}
        <Row label="Signals Evaluated">
          <span className="text-text-secondary">{signalsEvaluated}</span>
        </Row>
      </CardContent>
    </Card>
  );
}
