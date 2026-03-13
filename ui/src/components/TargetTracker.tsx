import { usePolling } from "../hooks/usePolling";
import type { MarketsResponse } from "../types";
import { fmtApr } from "../utils/format";
import Panel from "./Panel";
import { Badge } from "./ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table";

interface TargetPosition {
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
  allTimePnl: number;
  settledPct: number;
}

interface TargetPositionsResponse {
  positions: TargetPosition[];
  targetAddress?: string;
  error?: string;
}

interface TargetTrackerProps {
  markets: MarketsResponse | null;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function fmtUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? "+" : "-";
  return `${sign}$${abs.toFixed(2)}`;
}

function getMarketName(marketId: number, markets: MarketsResponse | null): string {
  if (!markets?.results) return `#${marketId}`;
  for (const m of markets.results) {
    if (m.marketId === marketId) {
      const name = m.imData?.name ?? m.metadata?.platformName;
      return name ? String(name) : `#${marketId}`;
    }
  }
  return `#${marketId}`;
}

export default function TargetTracker({ markets }: TargetTrackerProps) {
  const { data, loading, error, stale } = usePolling<TargetPositionsResponse>("/api/copy-targets/positions", 10_000);

  const positions = data?.positions ?? [];
  const address = data?.targetAddress ? truncateAddress(data.targetAddress) : "--";
  const totalPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const totalNotional = positions.reduce((sum, p) => sum + p.notionalUsd, 0);
  const profitable = positions.filter(p => p.unrealizedPnl > 0).length;

  return (
    <Panel
      title="Target Tracker"
      meta={`${positions.length} pos (${profitable} green) | ${address} | PnL: ${fmtUsd(totalPnl)}`}
      loading={loading}
      empty={positions.length === 0}
      emptyText="No target positions"
      emptyHint="Target address not configured or target has no open positions"
      error={data?.error ?? error}
      stale={stale}
    >
      <div className="flex items-center gap-3 px-2 py-1 border-b border-border text-[10px] text-text-muted">
        <span>Notional: <span className="text-text-secondary font-mono">${totalNotional.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></span>
        <span>Unrealized: <span className={`font-mono font-semibold ${totalPnl >= 0 ? "text-green" : "text-red"}`}>{fmtUsd(totalPnl)}</span></span>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Market</TableHead>
            <TableHead>Side</TableHead>
            <TableHead>Notional</TableHead>
            <TableHead>Entry</TableHead>
            <TableHead>Mark</TableHead>
            <TableHead>PnL (USD)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {positions.map((p) => {
            const pnlColor = p.unrealizedPnl > 0 ? "text-green" : p.unrealizedPnl < 0 ? "text-red" : "text-text-muted";
            return (
              <TableRow key={`${p.marketId}-${p.side}`}>
                <TableCell className="text-coral font-semibold text-xs">{getMarketName(p.marketId, markets)}</TableCell>
                <TableCell>
                  <Badge variant={p.side.toLowerCase() === "long" ? "long" : "short"}>{p.side}</Badge>
                </TableCell>
                <TableCell className="text-xs font-mono">${p.notionalUsd.toFixed(0)}</TableCell>
                <TableCell className="text-xs font-mono">{fmtApr(p.fixedApr)}</TableCell>
                <TableCell className="text-xs font-mono">{fmtApr(p.markApr)}</TableCell>
                <TableCell className={`text-xs font-mono font-semibold ${pnlColor}`}>
                  {fmtUsd(p.unrealizedPnl)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Panel>
  );
}
