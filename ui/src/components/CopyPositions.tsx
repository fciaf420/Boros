import { useMemo } from "react";
import type { CopyPositionRow, MarketsResponse } from "../types";
import { fmtApr, fmtUsd, fmtTime } from "../utils/format";
import Panel from "./Panel";
import { Badge } from "./ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table";

interface CopyPositionsProps {
  positions: CopyPositionRow[] | null;
  loading: boolean;
  lastUpdated: number | null;
  error: string | null;
  stale: boolean;
  markets?: MarketsResponse | null;
}

export default function CopyPositions({ positions, loading, lastUpdated, error, stale, markets }: CopyPositionsProps) {
  const rows = positions ?? [];
  const updated = lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "--";

  const marketNames = useMemo(() => {
    const map = new Map<number, string>();
    if (markets?.results) {
      for (const m of markets.results) {
        const name = m.metadata?.assetSymbol || m.imData?.symbol || String(m.marketId);
        map.set(m.marketId, name);
      }
    }
    return map;
  }, [markets]);

  return (
    <Panel
      title="Copy Positions"
      meta={`${rows.length} open | ${updated}`}
      loading={loading}
      empty={rows.length === 0}
      emptyText="No copy positions"
      emptyHint="Waiting for target to open positions, or edge/risk limits not met"
      error={error}
      stale={stale}
    >
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Market</TableHead>
            <TableHead>Side</TableHead>
            <TableHead>Entry APR</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Notional</TableHead>
            <TableHead>Margin</TableHead>
            <TableHead>Opened</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((p) => {
            const marketName = marketNames.get(p.market_id) ?? String(p.market_id);

            return (
              <TableRow key={p.id}>
                <TableCell className="text-coral font-semibold">{marketName}</TableCell>
                <TableCell>
                  <Badge variant={p.side.toLowerCase() === "long" ? "long" : "short"}>{p.side}</Badge>
                </TableCell>
                <TableCell>{fmtApr(p.entry_apr)}</TableCell>
                <TableCell>{p.size_base.toFixed(4)}</TableCell>
                <TableCell>{fmtUsd(p.notional_usd)}</TableCell>
                <TableCell>{fmtUsd(p.margin_usd)}</TableCell>
                <TableCell className="text-text-muted">{fmtTime(p.opened_at)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Panel>
  );
}
