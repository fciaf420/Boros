import { useState } from "react";
import type { MarketsResponse, MarketSummary } from "../types";

interface MarketGridProps {
  markets: MarketsResponse | null;
  loading: boolean;
  lastUpdated: number | null;
}

type SortKey = "symbol" | "platform" | "midApr" | "floatingApr" | "spread" | "volume" | "oi" | "maturity" | "price";
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
  }
}

function fmtApr(v: number): string {
  return (v * 100).toFixed(2) + "%";
}

function fmtUsd(v: number): string {
  if (v >= 1_000_000) return "$" + (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return "$" + (v / 1_000).toFixed(1) + "K";
  return "$" + v.toFixed(0);
}

function fmtDays(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  return days + "d";
}

export default function MarketGrid({ markets, loading, lastUpdated }: MarketGridProps) {
  const [sortKey, setSortKey] = useState<SortKey>("oi");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const rows = markets?.results ?? [];
  const sorted = [...rows].sort((a, b) => {
    const va = getVal(a, sortKey);
    const vb = getVal(b, sortKey);
    const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    return sortDir === "asc" ? cmp : -cmp;
  });

  const arrow = (key: SortKey) => sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";
  const updated = lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "--";

  return (
    <div className="panel">
      <div className="panel__header">
        <span className="panel__title">Markets</span>
        <span className="panel__meta">
          {loading ? <span className="loading-dots">loading</span> : `${rows.length} markets | ${updated}`}
        </span>
      </div>
      <div className="panel__body">
        {rows.length === 0 && !loading ? (
          <div className="empty-state">NO MARKET DATA</div>
        ) : (
          <table className="t-table">
            <thead>
              <tr>
                <th onClick={() => handleSort("symbol")}>Symbol{arrow("symbol")}</th>
                <th onClick={() => handleSort("platform")}>Platform{arrow("platform")}</th>
                <th onClick={() => handleSort("midApr")}>Mid APR{arrow("midApr")}</th>
                <th onClick={() => handleSort("floatingApr")}>Float APR{arrow("floatingApr")}</th>
                <th>Bid</th>
                <th>Ask</th>
                <th onClick={() => handleSort("spread")}>Sprd bps{arrow("spread")}</th>
                <th onClick={() => handleSort("volume")}>24h Vol{arrow("volume")}</th>
                <th onClick={() => handleSort("oi")}>OI{arrow("oi")}</th>
                <th onClick={() => handleSort("maturity")}>Maturity{arrow("maturity")}</th>
                <th onClick={() => handleSort("price")}>Mark ${arrow("price")}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => {
                const spread = ((m.data?.bestAsk ?? 0) - (m.data?.bestBid ?? 0)) * 10000;
                return (
                  <tr key={m.marketId}>
                    <td className="val-cyan">{m.imData?.symbol}</td>
                    <td className="val-neutral">{m.metadata?.platformName}</td>
                    <td>{fmtApr(m.data?.midApr ?? 0)}</td>
                    <td>{fmtApr(m.data?.floatingApr ?? 0)}</td>
                    <td className="val-pos">{fmtApr(m.data?.bestBid ?? 0)}</td>
                    <td className="val-neg">{fmtApr(m.data?.bestAsk ?? 0)}</td>
                    <td className={spread > 0 ? "val-amber" : "val-neutral"}>{spread.toFixed(0)}</td>
                    <td>{fmtUsd(m.data?.volume24h ?? 0)}</td>
                    <td>{fmtUsd(m.data?.notionalOI ?? 0)}</td>
                    <td className="val-neutral">{fmtDays(m.data?.timeToMaturity ?? 0)}</td>
                    <td>{fmtUsd(m.data?.assetMarkPrice ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
