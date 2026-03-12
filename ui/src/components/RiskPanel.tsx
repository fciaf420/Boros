import { useMemo } from "react";
import type { RiskState, PositionRow, SignalRow, TradeCandidate } from "../types";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Separator } from "./ui/separator";
import { fmtUsd } from "../utils/format";
import { cn } from "@/lib/utils";

interface RiskPanelProps {
  className?: string;
  riskState: RiskState | null;
  positions: PositionRow[] | null;
  signals: SignalRow[] | null;
  availableBalance?: number | null;
}

/* ---------- tiny helpers ---------- */

function Row({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className="flex items-center justify-between py-[2px]">
      <span className="text-[11px] tracking-wide text-text-muted">{label}</span>
      <span className={cn("text-[13px] font-mono tabular-nums", className)}>{children}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold tracking-wide text-text-muted px-0.5 pt-1 pb-0.5">
      {children}
    </div>
  );
}

function pnlColor(v: number) {
  return v >= 0 ? "text-green" : "text-red";
}

function liqBufferColor(bps: number) {
  if (bps > 500) return "text-green";
  if (bps >= 200) return "text-amber";
  return "text-red";
}

/* ---------- component ---------- */

export default function RiskPanel({ className, riskState, positions, signals, availableBalance }: RiskPanelProps) {
  /* ---- derived from on-chain position data ---- */
  const posMetrics = useMemo(() => {
    const rows = positions ?? [];
    const open = rows.filter((p) => p.status.toLowerCase() === "open" || p.status.toLowerCase() === "active");
    const list = open.length > 0 ? open : rows;

    const liqBuffers = list
      .map((p) => p.liquidation_buffer_bps)
      .filter((b): b is number => b != null);

    const worstLiqBuffer = liqBuffers.length > 0 ? Math.min(...liqBuffers) : null;

    const avgLeverage = list.length > 0
      ? list.reduce((sum, p) => sum + p.actual_leverage, 0) / list.length
      : 0;

    const totalUnrealized = list.reduce((sum, p) => sum + p.unrealized_pnl_usd, 0);

    const totalRealized = list.reduce(
      (sum, p) => sum + p.realized_carry_pnl_usd + p.realized_trading_pnl_usd,
      0
    );

    // Sum actual margin locked in positions (on-chain truth)
    const usedMargin = list.reduce((sum, p) => sum + p.initial_margin_usd, 0);

    // Sum notional across open positions
    const totalNotional = list.reduce((sum, p) => sum + p.notional_usd, 0);

    return {
      worstLiqBuffer,
      avgLeverage,
      totalUnrealized,
      totalRealized,
      usedMargin,
      totalNotional,
      count: list.length,
    };
  }, [positions]);

  /* ---- derived top signals ---- */
  const topSignals = useMemo(() => {
    const rows = signals ?? [];
    let bestLong: { marketId: number; netEdgeBps: number } | null = null;
    let bestShort: { marketId: number; netEdgeBps: number } | null = null;

    for (const s of rows) {
      if (!s.candidate_json) continue;
      try {
        const c: TradeCandidate = JSON.parse(s.candidate_json);
        if (c.side === "LONG") {
          if (!bestLong || c.netEdgeBps > bestLong.netEdgeBps) {
            bestLong = { marketId: c.marketId, netEdgeBps: c.netEdgeBps };
          }
        } else if (c.side === "SHORT") {
          if (!bestShort || c.netEdgeBps > bestShort.netEdgeBps) {
            bestShort = { marketId: c.marketId, netEdgeBps: c.netEdgeBps };
          }
        }
      } catch {
        /* malformed json, skip */
      }
    }

    return { bestLong, bestShort };
  }, [signals]);

  /* ---- margin utilization (from on-chain positions vs equity) ---- */
  const equity = riskState?.equityUsd ?? 0;
  const usedMargin = posMetrics?.usedMargin ?? 0;
  const marginUtil = equity > 0 ? (usedMargin / equity) * 100 : 0;

  const killActive = riskState?.killSwitchActive ?? false;
  const failStreak = riskState?.failureStreak ?? 0;
  const dailyPnl = riskState?.dailyPnlPct ?? 0;

  return (
    <Card className={cn("overflow-auto", className)}>
      <CardHeader>
        <CardTitle>Risk</CardTitle>
        {killActive && <Badge variant="live">KILL SWITCH</Badge>}
      </CardHeader>

      <CardContent className="space-y-1 p-2">
        {/* ========= ACCOUNT SECTION (on-chain derived) ========= */}
        <SectionLabel>Account</SectionLabel>

        <div className="space-y-[2px]">
          {equity > 0 && (
            <Row label="Equity">{fmtUsd(equity)}</Row>
          )}

          {availableBalance != null && availableBalance > 0 && (
            <Row label="Available" className="text-green">{fmtUsd(availableBalance)}</Row>
          )}

          {/* Margin from actual positions, not bot internal state */}
          <Row label="Used Margin" className={usedMargin > 0 ? "text-coral" : "text-text-muted"}>
            {usedMargin > 0 ? fmtUsd(usedMargin) : "None"}
          </Row>

          {posMetrics && posMetrics.totalNotional > 0 && (
            <Row label="Total Notional">{fmtUsd(posMetrics.totalNotional)}</Row>
          )}

          {/* margin utilization bar — only show when there's something to show */}
          {equity > 0 && usedMargin > 0 && (
            <div className="py-[2px]">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[11px] tracking-wide text-text-muted">Margin Util</span>
                <span className="text-xs font-mono tabular-nums">{marginUtil.toFixed(1)}%</span>
              </div>
              <div className="h-1.5 w-full bg-border rounded-sm overflow-hidden">
                <div
                  className={`h-full rounded-sm transition-all duration-300 ${
                    marginUtil > 80 ? "bg-red" : marginUtil > 50 ? "bg-amber" : "bg-green"
                  }`}
                  style={{ width: `${Math.min(marginUtil, 100)}%` }}
                />
              </div>
            </div>
          )}

          {riskState && (
            <Row label="Daily PnL" className={pnlColor(dailyPnl)}>
              {dailyPnl >= 0 ? "+" : ""}{dailyPnl.toFixed(2)}%
            </Row>
          )}

          {failStreak > 0 && (
            <Row label="Fail Streak" className="text-red">{failStreak}</Row>
          )}
        </div>

        <Separator className="my-1.5" />

        {/* ========= POSITION RISK SECTION ========= */}
        <SectionLabel>Position Risk</SectionLabel>

        {posMetrics && posMetrics.count > 0 ? (
          <div className="space-y-[2px]">
            <Row label="Open Positions" className="text-coral">
              {posMetrics.count}
            </Row>

            <Row
              label="Worst Liq Buffer"
              className={
                posMetrics.worstLiqBuffer != null
                  ? liqBufferColor(posMetrics.worstLiqBuffer)
                  : "text-text-muted"
              }
            >
              {posMetrics.worstLiqBuffer != null
                ? `${posMetrics.worstLiqBuffer.toFixed(0)} bps`
                : "--"}
            </Row>

            <Row label="Avg Leverage" className="text-amber">
              {posMetrics.avgLeverage.toFixed(1)}x
            </Row>

            <Row label="Unreal PnL" className={pnlColor(posMetrics.totalUnrealized)}>
              {fmtUsd(posMetrics.totalUnrealized, { signed: true })}
            </Row>

            <Row label="Real PnL" className={pnlColor(posMetrics.totalRealized)}>
              {fmtUsd(posMetrics.totalRealized, { signed: true })}
            </Row>
          </div>
        ) : (
          <div className="text-xs text-text-muted text-center py-2">No open positions</div>
        )}

        <Separator className="my-1.5" />

        {/* ========= TOP SIGNALS SECTION ========= */}
        <SectionLabel>Top Signals</SectionLabel>

        {topSignals.bestLong || topSignals.bestShort ? (
          <div className="space-y-1">
            {topSignals.bestLong && (
              <a
                href={`https://boros.pendle.finance/markets/${topSignals.bestLong.marketId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between py-[2px] cursor-pointer hover:bg-coral/5 rounded px-0.5 -mx-0.5 transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <Badge variant="long">LONG</Badge>
                  <span className="text-xs font-mono text-coral">{topSignals.bestLong.marketId}</span>
                </div>
                <span className="text-xs font-mono tabular-nums text-green">
                  {topSignals.bestLong.netEdgeBps.toFixed(1)} bps
                </span>
              </a>
            )}
            {topSignals.bestShort && (
              <a
                href={`https://boros.pendle.finance/markets/${topSignals.bestShort.marketId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between py-[2px] cursor-pointer hover:bg-coral/5 rounded px-0.5 -mx-0.5 transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <Badge variant="short">SHORT</Badge>
                  <span className="text-xs font-mono text-coral">{topSignals.bestShort.marketId}</span>
                </div>
                <span className="text-xs font-mono tabular-nums text-green">
                  {topSignals.bestShort.netEdgeBps.toFixed(1)} bps
                </span>
              </a>
            )}
          </div>
        ) : (
          <div className="text-xs text-text-muted text-center py-2">
            No actionable signals
          </div>
        )}
      </CardContent>
    </Card>
  );
}
