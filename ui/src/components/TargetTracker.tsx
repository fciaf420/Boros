import type { CopyTargetRow, TargetPositionSnapshot } from "../types";
import { fmtApr, fmtTime } from "../utils/format";
import Panel from "./Panel";
import { Badge } from "./ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table";

interface TargetTrackerProps {
  targets: CopyTargetRow[] | null;
  loading: boolean;
  lastUpdated: number | null;
  error: string | null;
  stale: boolean;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

export default function TargetTracker({ targets, loading, error, stale }: TargetTrackerProps) {
  const target = targets?.[0] ?? null;

  let snapshots: TargetPositionSnapshot[] = [];
  if (target) {
    try {
      snapshots = JSON.parse(target.snapshot_json) as TargetPositionSnapshot[];
    } catch {
      snapshots = [];
    }
  }

  const address = target ? truncateAddress(target.target_address) : "--";
  const updated = target ? fmtTime(target.recorded_at) : "--";

  return (
    <Panel
      title="Target Tracker"
      meta={`${snapshots.length} positions | ${address} | ${updated}`}
      loading={loading}
      empty={snapshots.length === 0}
      emptyText="No target data"
      emptyHint="Target address not configured or target has no open positions"
      error={error}
      stale={stale}
    >
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Market ID</TableHead>
            <TableHead>Side</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Entry APR</TableHead>
            <TableHead>Current APR</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {snapshots.map((s) => (
            <TableRow key={`${s.marketId}-${s.side}`}>
              <TableCell className="text-coral font-semibold">{s.marketId}</TableCell>
              <TableCell>
                <Badge variant={s.side.toLowerCase() === "long" ? "long" : "short"}>{s.side}</Badge>
              </TableCell>
              <TableCell className="text-xs font-mono">{s.sizeBase.toFixed(4)}</TableCell>
              <TableCell className="text-xs font-mono">{fmtApr(s.entryApr)}</TableCell>
              <TableCell className="text-xs font-mono">{fmtApr(s.currentApr)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}
