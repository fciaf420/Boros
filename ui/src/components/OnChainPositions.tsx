import { useMemo } from "react";
import type { OnChainPosition, MarketsResponse } from "../types";
import { fmtApr, fmtUsd } from "../utils/format";
import Panel from "./Panel";
import { Badge } from "./ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table";

interface OnChainPositionsProps {
  positions: OnChainPosition[] | null;
  markets: MarketsResponse | null;
  loading: boolean;
  lastUpdated: number | null;
  error: string | null;
  stale: boolean;
}

/** Build a marketId -> display name lookup from the markets response. */
function buildMarketNames(markets: MarketsResponse | null): Map<number, string> {
  const map = new Map<number, string>();
  if (!markets?.results) return map;
  for (const m of markets.results) {
    const label = m.metadata?.assetSymbol
      ? `${m.metadata.assetSymbol} (${m.metadata.platformName})`
      : m.imData?.name ?? `Market ${m.marketId}`;
    map.set(m.marketId, label);
  }
  return map;
}

export default function OnChainPositions({
  positions,
  markets,
  loading,
  lastUpdated,
  error,
  stale,
}: OnChainPositionsProps) {
  const rows = positions ?? [];
  const updated = lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "--";
  const nameMap = buildMarketNames(markets);

  const totalPnl = useMemo(
    () => rows.reduce((sum, p) => sum + p.unrealizedPnl, 0),
    [rows],
  );

  const pnlMeta = rows.length > 0
    ? `${rows.length} open | PnL ${totalPnl >= 0 ? "+" : ""}$${Math.abs(totalPnl).toFixed(2)} | ${updated}`
    : `0 open | ${updated}`;

  return (
    <Panel
      title="On-Chain Positions"
      meta={pnlMeta}
      loading={loading}
      empty={rows.length === 0}
      emptyText="No on-chain positions found for this account"
      error={error}
      stale={stale}
    >
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Market</TableHead>
            <TableHead>Side</TableHead>
            <TableHead className="text-right">Notional</TableHead>
            <TableHead className="text-right">Margin</TableHead>
            <TableHead className="text-right">Fixed APR</TableHead>
            <TableHead className="text-right">Mark APR</TableHead>
            <TableHead className="text-right">PnL</TableHead>
            <TableHead className="text-right">Liq Buffer</TableHead>
            <TableHead>Type</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((p, i) => {
            const displayName = nameMap.get(p.marketId) ?? `Market ${p.marketId}`;
            const sideVariant = p.side.toLowerCase() === "long" ? "long" : "short";
            const pnlColor = p.unrealizedPnl >= 0 ? "text-green" : "text-red";
            const bufferColor = p.liquidationBufferBps == null
              ? "text-text-muted"
              : p.liquidationBufferBps > 500
                ? "text-green"
                : p.liquidationBufferBps >= 200
                  ? "text-amber"
                  : "text-red";

            return (
              <TableRow key={`${p.marketId}-${p.side}-${i}`}>
                <TableCell className="text-coral font-semibold">{displayName}</TableCell>
                <TableCell>
                  <Badge variant={sideVariant}>{p.side}</Badge>
                </TableCell>
                <TableCell className="text-right">{fmtUsd(p.notionalUsd)}</TableCell>
                <TableCell className="text-right">{fmtUsd(p.initialMarginUsd)}</TableCell>
                <TableCell className="text-right">{fmtApr(p.fixedApr)}</TableCell>
                <TableCell className="text-right">{fmtApr(p.markApr)}</TableCell>
                <TableCell className={`text-right font-semibold ${pnlColor}`}>
                  {fmtUsd(p.unrealizedPnl, { signed: true })}
                </TableCell>
                <TableCell className={`text-right ${bufferColor}`}>
                  {p.liquidationBufferBps != null ? `${p.liquidationBufferBps.toFixed(0)} bps` : "--"}
                </TableCell>
                <TableCell>
                  <Badge variant={p.marginType === "cross" ? "blue" : "muted"}>
                    {p.marginType}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Panel>
  );
}
