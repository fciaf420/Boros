import { useState, useMemo } from "react";
import type { MarketsResponse, MarketSummary, SignalRow, TradeCandidate } from "../types";
import { fmtApr, fmtUsd, fmtDays } from "../utils/format";
import Panel from "./Panel";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import MarketDetail from "./MarketDetail";

const HEADER_TIPS: Record<string, string> = {
  midApr: "Mid APR — midpoint between best bid and best ask implied APR. Represents the market's consensus fixed rate.",
  floatingApr: "Float APR — the current floating/underlying rate from the protocol. This is what you earn/pay if you don't hedge.",
  bid: "Bid — best bid APR in the order book. The highest rate someone is willing to pay to go long (receive fixed).",
  ask: "Ask — best ask APR in the order book. The lowest rate someone is willing to accept to go short (pay fixed).",
  spread: "Spread (bps) — difference between best ask and best bid in basis points. Lower = more liquid. 1 bps = 0.01%.",
  mark: "Mark Price — the current spot price of the underlying asset in USD.",
  edge: "Net Edge (bps) — fee-adjusted edge from the signal scanner. This is the expected profit in basis points AFTER trading fees. Green border = long signal > 100bps, red border = short signal > 100bps. Matches the Top Signals panel in Risk.",
};

interface MarketGridProps {
  markets: MarketsResponse | null;
  loading: boolean;
  lastUpdated: number | null;
  error: string | null;
  stale: boolean;
  signals?: SignalRow[] | null;
  positionMarketIds?: number[] | null;
}

type SortKey = "symbol" | "platform" | "midApr" | "floatingApr" | "spread" | "edge" | "volume" | "oi" | "maturity" | "price";
type SortDir = "asc" | "desc";

function getVal(m: MarketSummary, key: SortKey): number | string {
  switch (key) {
    case "symbol": return m.imData?.symbol ?? "";
    case "platform": return m.metadata?.platformName ?? "";
    case "midApr": return m.data?.midApr ?? 0;
    case "floatingApr": return m.data?.floatingApr ?? 0;
    case "spread": return (m.data?.bestAsk ?? 0) - (m.data?.bestBid ?? 0);
    case "volume": return m.data?.volume24h ?? 0;
    case "oi": return m.data?.notionalOI ?? 0;
    case "maturity": return m.data?.timeToMaturity ?? 0;
    case "price": return m.data?.assetMarkPrice ?? 0;
    default: return 0;
  }
}

export default function MarketGrid({ markets, loading, lastUpdated, error, stale, signals, positionMarketIds }: MarketGridProps) {
  const [sortKey, setSortKey] = useState<SortKey>("oi");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [search, setSearch] = useState("");

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  // Build signal lookup: latest signal per market_id (before sort so edge sort works)
  const signalMap = new Map<number, SignalRow>();
  if (signals) {
    for (const s of signals) {
      const existing = signalMap.get(s.market_id);
      if (!existing || s.recorded_at > existing.recorded_at) {
        signalMap.set(s.market_id, s);
      }
    }
  }

  // Parse candidate_json once to get net edge (after fees) per market
  const netEdgeMap = useMemo(() => {
    const map = new Map<number, number>();
    if (!signals) return map;
    for (const s of signals) {
      if (!s.candidate_json) continue;
      try {
        const c: TradeCandidate = JSON.parse(s.candidate_json);
        const existing = map.get(s.market_id);
        if (existing === undefined || Math.abs(c.netEdgeBps) > Math.abs(existing)) {
          map.set(s.market_id, c.netEdgeBps);
        }
      } catch { /* skip malformed */ }
    }
    return map;
  }, [signals]);

  // Net edge for a market — from candidate if available, else raw signal edge
  const bestEdgeFor = (id: number): number => {
    const net = netEdgeMap.get(id);
    if (net !== undefined) return net;
    const s = signalMap.get(id);
    if (!s) return 0;
    return Math.abs(s.edge_bps_long) > Math.abs(s.edge_bps_short) ? s.edge_bps_long : s.edge_bps_short;
  };

  const allRows = markets?.results ?? [];
  const rows = search
    ? allRows.filter(m => {
        const q = search.toLowerCase();
        return (m.imData?.symbol ?? "").toLowerCase().includes(q)
          || (m.metadata?.platformName ?? "").toLowerCase().includes(q)
          || String(m.marketId).includes(q);
      })
    : allRows;
  const sorted = [...rows].sort((a, b) => {
    if (sortKey === "edge") {
      const cmp = bestEdgeFor(a.marketId) - bestEdgeFor(b.marketId);
      return sortDir === "asc" ? cmp : -cmp;
    }
    const va = getVal(a, sortKey);
    const vb = getVal(b, sortKey);
    const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    return sortDir === "asc" ? cmp : -cmp;
  });

  const positionSet = useMemo(
    () => new Set(positionMarketIds ?? []),
    [positionMarketIds],
  );

  const arrow = (key: SortKey) => sortKey === key ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : "";
  const updated = lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "--";

  return (
    <Panel
      title="Markets"
      meta={`${rows.length}${search ? `/${allRows.length}` : ""} markets | ${updated}`}
      loading={loading}
      empty={rows.length === 0}
      emptyText="No market data"
      emptyHint="Boros API may be unavailable or rate-limited"
      error={error}
      stale={stale}
    >
      <div className="px-2 pb-1">
        <input
          className="w-full bg-background border border-border text-text-primary font-mono text-[11px] px-2 py-1 outline-none focus:border-coral/50 placeholder:text-text-muted/50"
          placeholder="Filter by symbol, platform, or ID..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>
      <TooltipProvider delayDuration={200}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead onClick={() => handleSort("symbol")}>Symbol{arrow("symbol")}</TableHead>
            <TableHead onClick={() => handleSort("platform")}>Platform{arrow("platform")}</TableHead>
            <TableHead className="text-right" onClick={() => handleSort("midApr")}>
              <Tooltip><TooltipTrigger asChild><span>Mid APR{arrow("midApr")}</span></TooltipTrigger><TooltipContent>{HEADER_TIPS.midApr}</TooltipContent></Tooltip>
            </TableHead>
            <TableHead className="text-right" onClick={() => handleSort("floatingApr")}>
              <Tooltip><TooltipTrigger asChild><span>Float APR{arrow("floatingApr")}</span></TooltipTrigger><TooltipContent>{HEADER_TIPS.floatingApr}</TooltipContent></Tooltip>
            </TableHead>
            <TableHead className="text-right">
              <Tooltip><TooltipTrigger asChild><span>Bid</span></TooltipTrigger><TooltipContent>{HEADER_TIPS.bid}</TooltipContent></Tooltip>
            </TableHead>
            <TableHead className="text-right">
              <Tooltip><TooltipTrigger asChild><span>Ask</span></TooltipTrigger><TooltipContent>{HEADER_TIPS.ask}</TooltipContent></Tooltip>
            </TableHead>
            <TableHead className="text-right" onClick={() => handleSort("spread")}>
              <Tooltip><TooltipTrigger asChild><span>Sprd bps{arrow("spread")}</span></TooltipTrigger><TooltipContent>{HEADER_TIPS.spread}</TooltipContent></Tooltip>
            </TableHead>
            <TableHead className="text-right" onClick={() => handleSort("edge")}>
              <Tooltip><TooltipTrigger asChild><span>Edge{arrow("edge")}</span></TooltipTrigger><TooltipContent className="max-w-[280px]">{HEADER_TIPS.edge}</TooltipContent></Tooltip>
            </TableHead>
            <TableHead className="text-right" onClick={() => handleSort("volume")}>24h Vol{arrow("volume")}</TableHead>
            <TableHead className="text-right" onClick={() => handleSort("oi")}>OI{arrow("oi")}</TableHead>
            <TableHead className="text-right" onClick={() => handleSort("maturity")}>Maturity{arrow("maturity")}</TableHead>
            <TableHead className="text-right" onClick={() => handleSort("price")}>
              <Tooltip><TooltipTrigger asChild><span>Mark ${arrow("price")}</span></TooltipTrigger><TooltipContent>{HEADER_TIPS.mark}</TooltipContent></Tooltip>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((m) => {
            const spread = ((m.data?.bestAsk ?? 0) - (m.data?.bestBid ?? 0)) * 10000;
            const signal = signalMap.get(m.marketId);
            const edge = bestEdgeFor(m.marketId);
            const hasPosition = positionSet.has(m.marketId);
            const borderClass = hasPosition
              ? "border-l-2 border-l-coral bg-coral/[0.04]"
              : signal
                ? signal.edge_bps_long > 100
                  ? "border-l-2 border-l-green/40"
                  : signal.edge_bps_short > 100
                    ? "border-l-2 border-l-red/40"
                    : ""
                : "";

            return (
              <TableRow
                key={m.marketId}
                className={`${borderClass} cursor-pointer hover:bg-coral/5`}
                onClick={() => window.open(`https://boros.pendle.finance/markets/${m.marketId}`, "_blank")}
              >
                <TableCell className="text-coral font-semibold">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span><span className="text-text-muted font-normal">{m.marketId}</span> {m.imData?.symbol}</span>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="p-3 bg-surface border border-border shadow-xl max-w-none">
                      <MarketDetail marketId={m.marketId} />
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="text-text-muted">{m.metadata?.platformName}</TableCell>
                <TableCell className="text-right">{fmtApr(m.data?.midApr ?? 0)}</TableCell>
                <TableCell className="text-right">{fmtApr(m.data?.floatingApr ?? 0)}</TableCell>
                <TableCell className="text-right text-green">{fmtApr(m.data?.bestBid ?? 0)}</TableCell>
                <TableCell className="text-right text-red">{fmtApr(m.data?.bestAsk ?? 0)}</TableCell>
                <TableCell className={`text-right ${spread > 50 ? "text-red" : spread > 20 ? "text-amber" : spread > 0 ? "text-text-secondary" : "text-text-muted"}`}>{spread.toFixed(0)}</TableCell>
                <TableCell className={`text-right ${edge !== 0 && Math.abs(edge) > 100 ? "text-green" : "text-text-muted"}`}>
                  {signal ? (
                    <>
                      <span className={`text-[9px] mr-0.5 ${(m.data?.floatingApr ?? 0) > (m.data?.midApr ?? 0) ? "text-green" : "text-red"}`}>
                        {(m.data?.floatingApr ?? 0) > (m.data?.midApr ?? 0) ? "L" : "S"}
                      </span>
                      {edge.toFixed(0)}
                    </>
                  ) : "--"}
                </TableCell>
                <TableCell className="text-right">{fmtUsd(m.data?.volume24h ?? 0)}</TableCell>
                <TableCell className="text-right">{fmtUsd(m.data?.notionalOI ?? 0)}</TableCell>
                <TableCell className="text-right text-text-muted">{fmtDays(m.data?.timeToMaturity ?? 0)}</TableCell>
                <TableCell className="text-right">{fmtUsd(m.data?.assetMarkPrice ?? 0)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      </TooltipProvider>
    </Panel>
  );
}
