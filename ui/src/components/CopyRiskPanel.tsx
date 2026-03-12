import { useMemo } from "react";
import type {
  RiskState,
  CopyPositionRow,
  CopyTargetRow,
  CopyTradeRow,
  TargetPositionSnapshot,
} from "../types";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Separator } from "./ui/separator";
import { fmtUsd, fmtTime } from "../utils/format";
import { cn } from "@/lib/utils";

interface CopyRiskPanelProps {
  className?: string;
  riskState: RiskState | null;
  copyPositions: CopyPositionRow[] | null;
  copyTargets: CopyTargetRow[] | null;
  copyTrades: CopyTradeRow[] | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sectionLabel = "text-[11px] font-semibold tracking-wide text-text-muted";
const valueClass = "text-[13px] font-mono tabular-nums";
const metricRow = "flex items-center justify-between";

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function parseSnapshots(json: string): TargetPositionSnapshot[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sizeDiffSignificant(a: number, b: number): boolean {
  if (a === 0 && b === 0) return false;
  const max = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / max > 0.05; // >5% difference
}

// ---------------------------------------------------------------------------
// Sub-sections
// ---------------------------------------------------------------------------

function AccountSection({ risk, copyPositions }: { risk: RiskState | null; copyPositions: CopyPositionRow[] | null }) {
  // Derive used margin from actual copy positions (on-chain truth)
  const usedMargin = (copyPositions ?? []).reduce((sum, p) => sum + p.margin_usd, 0);
  const equity = risk?.equityUsd ?? 0;
  const marginUtil = equity > 0 ? (usedMargin / equity) * 100 : 0;
  const clampedUtil = Math.min(marginUtil, 100);
  const dailyPnl = risk?.dailyPnlPct ?? 0;

  return (
    <div className="space-y-1.5">
      <span className={sectionLabel}>Account</span>

      {equity > 0 && (
        <div className={metricRow}>
          <span className="text-xs text-text-muted">Equity</span>
          <span className={valueClass}>{fmtUsd(equity)}</span>
        </div>
      )}

      <div className={metricRow}>
        <span className="text-xs text-text-muted">Used Margin</span>
        <span className={cn(valueClass, usedMargin > 0 ? "text-coral" : "text-text-muted")}>
          {usedMargin > 0 ? fmtUsd(usedMargin) : "None"}
        </span>
      </div>

      {equity > 0 && usedMargin > 0 && (
        <div className="space-y-0.5">
          <div className={metricRow}>
            <span className="text-xs text-text-muted">Margin Util</span>
            <span className={valueClass}>{marginUtil.toFixed(1)}%</span>
          </div>
          <div className="h-1 w-full rounded-full bg-border overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                clampedUtil > 80 ? "bg-red" : clampedUtil > 50 ? "bg-amber" : "bg-green"
              )}
              style={{ width: `${clampedUtil}%` }}
            />
          </div>
        </div>
      )}

      {risk && (
        <div className={metricRow}>
          <span className="text-xs text-text-muted">Daily PnL</span>
          <span className={cn(valueClass, dailyPnl >= 0 ? "text-green" : "text-red")}>
            {dailyPnl >= 0 ? "+" : ""}{dailyPnl.toFixed(2)}%
          </span>
        </div>
      )}
    </div>
  );
}

function CopyStatusSection({
  copyPositions,
  copyTargets,
}: {
  copyPositions: CopyPositionRow[] | null;
  copyTargets: CopyTargetRow[] | null;
}) {
  const latestTarget = copyTargets?.[0] ?? null;
  const posCount = copyPositions?.length ?? 0;

  return (
    <div className="space-y-1.5">
      <span className={sectionLabel}>Copy Status</span>

      <div className={metricRow}>
        <span className="text-xs text-text-muted">Copy Mode</span>
        <Badge variant="copy">ACTIVE</Badge>
      </div>

      <div className={metricRow}>
        <span className="text-xs text-text-muted">Target</span>
        <span className={cn(valueClass, "text-coral")}>
          {latestTarget ? truncateAddress(latestTarget.target_address) : "--"}
        </span>
      </div>

      <div className={metricRow}>
        <span className="text-xs text-text-muted">Positions Mirrored</span>
        <span className={valueClass}>{posCount}</span>
      </div>

      <div className={metricRow}>
        <span className="text-xs text-text-muted">Last Snapshot</span>
        <span className={cn(valueClass, "text-text-muted")}>
          {latestTarget ? fmtTime(latestTarget.recorded_at) : "--"}
        </span>
      </div>
    </div>
  );
}

function PositionComparisonSection({
  copyPositions,
  copyTargets,
}: {
  copyPositions: CopyPositionRow[] | null;
  copyTargets: CopyTargetRow[] | null;
}) {
  const latestTarget = copyTargets?.[0] ?? null;

  const targetSnapshots = useMemo<TargetPositionSnapshot[]>(() => {
    if (!latestTarget) return [];
    return parseSnapshots(latestTarget.snapshot_json);
  }, [latestTarget]);

  const posMap = useMemo(() => {
    const map = new Map<number, CopyPositionRow>();
    if (copyPositions) {
      for (const p of copyPositions) {
        map.set(p.market_id, p);
      }
    }
    return map;
  }, [copyPositions]);

  if (targetSnapshots.length === 0) {
    return (
      <div className="space-y-1.5">
        <span className={sectionLabel}>Position Comparison</span>
        <div className="text-text-muted text-xs">No target data</div>
      </div>
    );
  }

  // Collect all unique market IDs from both sides
  const allMarketIds = useMemo(() => {
    const ids = new Set<number>();
    for (const s of targetSnapshots) ids.add(s.marketId);
    if (copyPositions) {
      for (const p of copyPositions) ids.add(p.market_id);
    }
    return Array.from(ids).sort((a, b) => a - b);
  }, [targetSnapshots, copyPositions]);

  const targetMap = useMemo(() => {
    const map = new Map<number, TargetPositionSnapshot>();
    for (const s of targetSnapshots) {
      map.set(s.marketId, s);
    }
    return map;
  }, [targetSnapshots]);

  return (
    <div className="space-y-1.5">
      <span className={sectionLabel}>Position Comparison</span>

      {/* Header row */}
      <div className="grid grid-cols-[1fr_1fr_1fr] gap-x-1 text-[10px] text-text-muted uppercase tracking-wide">
        <span>Market</span>
        <span className="text-center">Target</span>
        <span className="text-center">Ours</span>
      </div>

      {/* Data rows */}
      {allMarketIds.map((mktId) => {
        const target = targetMap.get(mktId);
        const ours = posMap.get(mktId);

        const sideMismatch =
          target && ours && target.side.toUpperCase() !== ours.side.toUpperCase();
        const sizeMismatch =
          target &&
          ours &&
          sizeDiffSignificant(target.sizeBase, ours.size_base);
        const onlyTarget = target && !ours;
        const onlyOurs = !target && ours;

        return (
          <div
            key={mktId}
            className="grid grid-cols-[1fr_1fr_1fr] gap-x-1 items-center"
          >
            <span className={cn(valueClass, "text-coral")}>{mktId}</span>

            {/* Target side / size */}
            <span
              className={cn(
                valueClass,
                "text-center",
                onlyTarget && "text-amber"
              )}
            >
              {target ? (
                <>
                  <span
                    className={cn(
                      sideMismatch && "text-amber",
                      !sideMismatch &&
                        (target.side === "LONG" ? "text-green" : "text-red")
                    )}
                  >
                    {target.side[0]}
                  </span>
                  {" "}
                  <span className={cn(sizeMismatch && "text-amber")}>
                    {target.sizeBase.toFixed(3)}
                  </span>
                </>
              ) : (
                <span className="text-text-muted">--</span>
              )}
            </span>

            {/* Our side / size */}
            <span
              className={cn(
                valueClass,
                "text-center",
                onlyOurs && "text-amber"
              )}
            >
              {ours ? (
                <>
                  <span
                    className={cn(
                      sideMismatch && "text-amber",
                      !sideMismatch &&
                        (ours.side.toUpperCase() === "LONG"
                          ? "text-green"
                          : "text-red")
                    )}
                  >
                    {ours.side[0]?.toUpperCase()}
                  </span>
                  {" "}
                  <span className={cn(sizeMismatch && "text-amber")}>
                    {ours.size_base.toFixed(3)}
                  </span>
                </>
              ) : (
                <span className="text-text-muted">--</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RecentActivitySection({
  copyTrades,
}: {
  copyTrades: CopyTradeRow[] | null;
}) {
  const trades = copyTrades ?? [];
  const last5 = trades.slice(0, 5);

  const totalCount = trades.length;
  const executedCount = trades.filter(
    (t) => t.status.toUpperCase() === "EXECUTED"
  ).length;
  const successRate =
    totalCount > 0 ? ((executedCount / totalCount) * 100).toFixed(0) : "--";

  return (
    <div className="space-y-1.5">
      <span className={sectionLabel}>Recent Activity</span>

      <div className={metricRow}>
        <span className="text-xs text-text-muted">Success Rate</span>
        <span
          className={cn(
            valueClass,
            totalCount > 0
              ? executedCount / totalCount >= 0.8
                ? "text-green"
                : executedCount / totalCount >= 0.5
                  ? "text-amber"
                  : "text-red"
              : "text-text-muted"
          )}
        >
          {successRate}
          {totalCount > 0 ? "%" : ""}{" "}
          <span className="text-text-muted">
            ({executedCount}/{totalCount})
          </span>
        </span>
      </div>

      {last5.length === 0 ? (
        <div className="text-text-muted text-xs">No trades yet</div>
      ) : (
        <div className="space-y-0.5">
          {last5.map((t) => {
            const statusUpper = t.status.toUpperCase();
            const variant: "long" | "short" | "muted" =
              statusUpper === "EXECUTED"
                ? "long"
                : statusUpper === "FAILED" || statusUpper === "REJECTED"
                  ? "short"
                  : "muted";
            return (
              <div
                key={t.id}
                className="flex items-center justify-between gap-1"
              >
                <span className={cn(valueClass, "text-text-secondary truncate flex-1")}>
                  {t.delta_action}{" "}
                  <span className="text-text-muted">#{t.target_market_id}</span>
                </span>
                <Badge variant={variant} className="shrink-0">
                  {t.status}
                </Badge>
                <span className={cn(valueClass, "text-text-muted shrink-0")}>
                  {fmtTime(t.recorded_at)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function CopyRiskPanel({
  className,
  riskState,
  copyPositions,
  copyTargets,
  copyTrades,
}: CopyRiskPanelProps) {
  return (
    <Card className={cn("overflow-auto", className)}>
      <CardHeader>
        <CardTitle>Copy Risk</CardTitle>
        <Badge variant="copy">COPY</Badge>
      </CardHeader>
      <CardContent className="space-y-2 p-2">
        <AccountSection risk={riskState} copyPositions={copyPositions} />

        <Separator />

        <CopyStatusSection
          copyPositions={copyPositions}
          copyTargets={copyTargets}
        />

        <Separator />

        <PositionComparisonSection
          copyPositions={copyPositions}
          copyTargets={copyTargets}
        />

        <Separator />

        <RecentActivitySection copyTrades={copyTrades} />
      </CardContent>
    </Card>
  );
}
