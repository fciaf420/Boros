import { useState, useEffect, useMemo, useCallback } from "react";
import type { MarketsResponse, WalletLookupResponse, WalletPosition, LeaderboardResponse } from "../types";
import { fmtApr, fmtUsd, fmtPct, fmtDate } from "../utils/format";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Separator } from "./ui/separator";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table";
import { cn } from "@/lib/utils";

interface WalletLookupProps {
  markets: MarketsResponse | null;
}

type Period = "7d" | "30d";

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

/* ---------- SVG Sparkline ---------- */

function EquityChart({ points, period }: { points: Array<{ timestamp: number; equity: number }>; period: Period }) {
  const filtered = useMemo(() => {
    if (points.length === 0) return [];
    const cutoff = points[points.length - 1].timestamp - (period === "7d" ? 7 * 86400 : 30 * 86400);
    const f = points.filter(p => p.timestamp >= cutoff);
    return f.length >= 2 ? f : points;
  }, [points, period]);

  if (filtered.length < 2) {
    return <div className="flex items-center justify-center h-full text-text-muted text-xs">Not enough data</div>;
  }

  const W = 340;
  const H = 140;
  const PAD = { top: 12, right: 8, bottom: 20, left: 50 };

  const minT = filtered[0].timestamp;
  const maxT = filtered[filtered.length - 1].timestamp;
  const eqs = filtered.map(p => p.equity);
  const minE = Math.min(...eqs);
  const maxE = Math.max(...eqs);
  const rangeE = maxE - minE || 1;
  const rangeT = maxT - minT || 1;

  const toX = (t: number) => PAD.left + ((t - minT) / rangeT) * (W - PAD.left - PAD.right);
  const toY = (e: number) => PAD.top + (1 - (e - minE) / rangeE) * (H - PAD.top - PAD.bottom);

  const linePts = filtered.map(p => `${toX(p.timestamp).toFixed(1)},${toY(p.equity).toFixed(1)}`).join(" ");
  const areaPath = `M${toX(filtered[0].timestamp).toFixed(1)},${(H - PAD.bottom).toFixed(1)} ` +
    filtered.map(p => `L${toX(p.timestamp).toFixed(1)},${toY(p.equity).toFixed(1)}`).join(" ") +
    ` L${toX(filtered[filtered.length - 1].timestamp).toFixed(1)},${(H - PAD.bottom).toFixed(1)} Z`;

  // Y-axis labels (3 ticks)
  const yTicks = [minE, minE + rangeE / 2, maxE];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ff6b4a" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#ff6b4a" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* grid lines */}
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={PAD.left} y1={toY(v)} x2={W - PAD.right} y2={toY(v)} stroke="#2a2b3d" strokeWidth="0.5" />
          <text x={PAD.left - 4} y={toY(v) + 3} textAnchor="end" fill="#8b8ca7" fontSize="8" fontFamily="monospace">
            ${v >= 1000 ? (v / 1000).toFixed(1) + "K" : v.toFixed(0)}
          </text>
        </g>
      ))}
      {/* date labels */}
      <text x={toX(minT)} y={H - 4} textAnchor="start" fill="#8b8ca7" fontSize="8" fontFamily="monospace">
        {fmtDate(minT)}
      </text>
      <text x={toX(maxT)} y={H - 4} textAnchor="end" fill="#8b8ca7" fontSize="8" fontFamily="monospace">
        {fmtDate(maxT)}
      </text>
      {/* area fill */}
      <path d={areaPath} fill="url(#eqGrad)" />
      {/* line */}
      <polyline points={linePts} fill="none" stroke="#ff6b4a" strokeWidth="1.5" strokeLinejoin="round" />
      {/* end dot */}
      <circle cx={toX(maxT)} cy={toY(filtered[filtered.length - 1].equity)} r="2.5" fill="#ff6b4a" />
    </svg>
  );
}

/* ---------- Positions Table ---------- */

function PositionsTable({ positions, nameMap }: { positions: WalletPosition[]; nameMap: Map<number, string> }) {
  const sorted = useMemo(() => [...positions].sort((a, b) => b.notionalUsd - a.notionalUsd), [positions]);

  if (sorted.length === 0) {
    return <div className="flex items-center justify-center h-full text-text-muted text-xs py-4">No open positions</div>;
  }

  return (
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
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((p, i) => {
          const name = nameMap.get(p.marketId) ?? `Market ${p.marketId}`;
          const pnlColor = p.unrealizedPnl >= 0 ? "text-green" : "text-red";
          const bufColor = p.liquidationBufferBps == null
            ? "text-text-muted"
            : p.liquidationBufferBps > 500 ? "text-green" : p.liquidationBufferBps >= 200 ? "text-amber" : "text-red";

          return (
            <TableRow key={`${p.marketId}-${p.side}-${i}`}>
              <TableCell className="text-coral font-semibold">{name}</TableCell>
              <TableCell>
                <Badge variant={p.side.toLowerCase() === "long" ? "long" : "short"}>{p.side}</Badge>
              </TableCell>
              <TableCell className="text-right">{fmtUsd(p.notionalUsd)}</TableCell>
              <TableCell className="text-right">{fmtUsd(p.initialMarginUsd)}</TableCell>
              <TableCell className="text-right">{fmtApr(p.fixedApr)}</TableCell>
              <TableCell className="text-right">{fmtApr(p.markApr)}</TableCell>
              <TableCell className={`text-right font-semibold ${pnlColor}`}>
                {fmtUsd(p.unrealizedPnl, { signed: true })}
              </TableCell>
              <TableCell className={`text-right ${bufColor}`}>
                {p.liquidationBufferBps != null ? `${p.liquidationBufferBps.toFixed(0)} bps` : "--"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/* ---------- Stats Sidebar ---------- */

function StatsSidebar({ data, nameMap }: { data: WalletLookupResponse; nameMap: Map<number, string> }) {
  const pnlColor = (v: number) => (v >= 0 ? "text-green" : "text-red");

  return (
    <Card className="overflow-auto">
      <CardHeader>
        <CardTitle>Stats</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 p-2">
        {/* Account */}
        {data.account && (
          <>
            <SectionLabel>Account</SectionLabel>
            <div className="space-y-[2px]">
              <Row label="Equity">{fmtUsd(data.account.equity)}</Row>
              <Row label="Available" className="text-green">{fmtUsd(data.account.availableBalance)}</Row>
              <Row label="Margin Used" className="text-coral">{fmtUsd(data.account.initialMarginUsed)}</Row>
              <Row label="Daily PnL" className={pnlColor(data.account.dailyPnl)}>
                {fmtUsd(data.account.dailyPnl, { signed: true })}
              </Row>
            </div>
            <Separator className="my-1.5" />
          </>
        )}

        {/* Performance */}
        {data.performance && (
          <>
            <SectionLabel>Performance</SectionLabel>
            <div className="space-y-[2px]">
              <Row label="Total Return" className={pnlColor(data.performance.totalReturnPct)}>
                {fmtPct(data.performance.totalReturnPct, true)}
              </Row>
              <Row label="Annualized" className={pnlColor(data.performance.annualizedReturnPct)}>
                {fmtPct(data.performance.annualizedReturnPct, true)}
              </Row>
              <Row label="Max Drawdown" className="text-red">
                {fmtPct(data.performance.maxDrawdownPct)}
              </Row>
              <Row label="Period">
                {data.performance.periodDays}d
              </Row>
            </div>
            <Separator className="my-1.5" />
          </>
        )}

        {/* Trading Activity */}
        {data.tradingActivity && (
          <>
            <SectionLabel>Trading</SectionLabel>
            <div className="space-y-[2px]">
              <Row label="Total Orders">{data.tradingActivity.totalOrders}</Row>
              <Row label="Filled">{data.tradingActivity.filledOrders}</Row>
              <Row label="Fill Rate" className="text-coral">
                {fmtPct(data.tradingActivity.fillRate)}
              </Row>
              <Row label="Active Days">{data.tradingActivity.activeDays}</Row>
            </div>

            {data.tradingActivity.marketBreakdown.length > 0 && (
              <div className="mt-1.5">
                <div className="text-[10px] text-text-muted mb-0.5">Top Markets</div>
                {data.tradingActivity.marketBreakdown.slice(0, 5).map(mb => (
                  <div key={mb.marketId} className="flex items-center justify-between py-[1px]">
                    <span className="text-[11px] font-mono text-coral truncate mr-1">{nameMap.get(mb.marketId) ?? `Market ${mb.marketId}`}</span>
                    <span className="text-[11px] font-mono tabular-nums text-text-secondary shrink-0">{mb.count}</span>
                  </div>
                ))}
              </div>
            )}
            <Separator className="my-1.5" />
          </>
        )}

        {/* Referral */}
        {data.referral && (
          <>
            <SectionLabel>Referral</SectionLabel>
            <div className="space-y-[2px]">
              {data.referral.code && <Row label="Code" className="text-coral">{data.referral.code}</Row>}
              <Row label="Total Volume">{fmtUsd(data.referral.totalVolume)}</Row>
              <Row label="Fee Share">{(data.referral.feeShare * 100).toFixed(1)}%</Row>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------- Leaderboard ---------- */

function Leaderboard({ data, loading, period, onSelectWallet, onRefresh }: {
  data: LeaderboardResponse | null;
  loading: boolean;
  period: Period;
  onSelectWallet: (addr: string) => void;
  onRefresh: () => void;
}) {
  const sorted = useMemo(() => {
    if (!data?.entries) return [];
    const key = period === "7d" ? "return7d" : "return30d";
    return [...data.entries]
      .filter(e => e[key] !== null)
      .sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
  }, [data?.entries, period]);

  const updated = data?.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : "--";

  // Parse progress percentage from scanProgress like "Scanning blocks: 60/208 chunks, 369 wallets found"
  // or "Fetching PnL: 50/100 wallets..."
  const progressPct = useMemo(() => {
    const p = data?.scanProgress ?? "";
    const chunkMatch = p.match(/(\d+)\/(\d+) chunks/);
    if (chunkMatch) return Math.round((parseInt(chunkMatch[1]) / parseInt(chunkMatch[2])) * 70);  // 0-70% for block scan
    const walletMatch = p.match(/Fetching PnL: (\d+)\/(\d+)/);
    if (walletMatch) return 70 + Math.round((parseInt(walletMatch[1]) / parseInt(walletMatch[2])) * 30);  // 70-100% for PnL
    if (data?.scanning) return 2;  // just started
    return 0;
  }, [data?.scanProgress, data?.scanning]);

  return (
    <Card className="h-full overflow-hidden flex flex-col">
      <CardHeader>
        <CardTitle>Leaderboard</CardTitle>
        <span className="text-[10px] text-text-muted">
          {data?.scanning ? (
            <span className="loading-dots text-amber">Scanning wallets</span>
          ) : data?.entries.length ? (
            <>{sorted.length} ranked / {data.walletCount} discovered | {updated}</>
          ) : loading ? (
            <span className="loading-dots">loading</span>
          ) : (
            <>No data yet</>
          )}
          <button
            onClick={onRefresh}
            className="ml-2 text-coral hover:text-coral/80 transition-colors"
            disabled={data?.scanning}
          >
            {data?.scanning ? "scanning..." : "scan"}
          </button>
        </span>
      </CardHeader>
      <CardContent className="flex-1 overflow-auto">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <span className="text-text-muted text-sm">
              {data?.scanning ? data.scanProgress || "Scanning on-chain events..." : "No leaderboard data yet"}
            </span>
            {!data?.scanning && (
              <button
                onClick={onRefresh}
                className="px-3 py-1.5 bg-coral/20 text-coral text-[11px] font-semibold rounded hover:bg-coral/30 transition-colors"
              >
                Start Scan
              </button>
            )}
            {data?.scanning && (
              <div className="flex flex-col items-center gap-1.5 w-full max-w-xs">
                <span className="text-text-muted/60 text-[11px] text-center">
                  Scanning Arbitrum blocks for Boros wallet activity, then fetching PnL data for each
                </span>
                {data.walletCount > 0 && (
                  <span className="text-coral text-[11px] font-mono">{data.walletCount} wallets discovered</span>
                )}
                <div className="h-1.5 w-full bg-border rounded-sm overflow-hidden">
                  <div
                    className="h-full bg-coral/60 rounded-sm transition-all duration-700 ease-out"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <span className="text-text-muted/50 text-[10px] font-mono">{progressPct}%</span>
              </div>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8">#</TableHead>
                <TableHead>Wallet</TableHead>
                <TableHead className="text-right">Equity</TableHead>
                <TableHead className="text-right">{period === "7d" ? "7d Return" : "30d Return"}</TableHead>
                <TableHead className="text-right">Max DD</TableHead>
                <TableHead className="text-right">Positions</TableHead>
                <TableHead className="text-right">Notional</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((entry, i) => {
                const ret = period === "7d" ? entry.return7d : entry.return30d;
                const retColor = ret != null ? (ret >= 0 ? "text-green" : "text-red") : "text-text-muted";
                const shortAddr = `${entry.address.slice(0, 6)}...${entry.address.slice(-4)}`;
                return (
                  <TableRow
                    key={entry.address}
                    className="cursor-pointer hover:bg-coral/5"
                    onClick={() => onSelectWallet(entry.address)}
                  >
                    <TableCell className="text-text-muted">{i + 1}</TableCell>
                    <TableCell className="font-mono text-coral">{shortAddr}</TableCell>
                    <TableCell className="text-right">{fmtUsd(entry.equity)}</TableCell>
                    <TableCell className={`text-right font-semibold ${retColor}`}>
                      {ret != null ? fmtPct(ret, true) : "--"}
                    </TableCell>
                    <TableCell className="text-right text-red">
                      {entry.maxDrawdown != null ? fmtPct(entry.maxDrawdown) : "--"}
                    </TableCell>
                    <TableCell className="text-right">{entry.positionCount}</TableCell>
                    <TableCell className="text-right">{fmtUsd(entry.totalNotional)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------- Main Component ---------- */

export default function WalletLookup({ markets }: WalletLookupProps) {
  const [address, setAddress] = useState("");
  const [submittedAddr, setSubmittedAddr] = useState<string | null>(null);
  const [fetchTick, setFetchTick] = useState(0);
  const [period, setPeriod] = useState<Period>("30d");
  const [data, setData] = useState<WalletLookupResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Leaderboard
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null);
  const [lbLoading, setLbLoading] = useState(false);

  useEffect(() => {
    setLbLoading(true);
    fetch("/api/leaderboard")
      .then(r => r.json())
      .then((json: LeaderboardResponse) => setLeaderboard(json))
      .catch(() => {})
      .finally(() => setLbLoading(false));
  }, []);

  const nameMap = useMemo(() => buildMarketNames(markets), [markets]);

  const doLookup = useCallback((addr: string) => {
    if (!addr || addr.length !== 42 || !addr.startsWith("0x")) return;
    setSubmittedAddr(addr);
  }, []);

  useEffect(() => {
    if (!submittedAddr) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/wallet/${submittedAddr}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json: WalletLookupResponse) => {
        if (!cancelled) setData(json);
      })
      .catch(err => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [submittedAddr, fetchTick]);

  const handleSubmit = () => doLookup(address);
  const handleRefresh = () => { if (submittedAddr) setFetchTick(t => t + 1); };

  const hasNoActivity = data && !data.account && data.positions.length === 0 && data.equityCurve.length === 0;

  return (
    <div className="flex flex-col h-full gap-0.5">
      {/* Input bar */}
      <Card className="shrink-0">
        <CardContent className="p-2">
          <div className="flex items-center gap-2">
            <input
              className="flex-1 bg-background border border-border text-text-primary font-mono text-[11px] px-2 py-1.5 outline-none focus:border-coral/50 placeholder:text-text-muted/50"
              placeholder="0x... wallet address"
              value={address}
              onChange={e => setAddress(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleSubmit(); }}
            />
            <div className="flex items-center gap-0.5 bg-background/60 rounded p-0.5">
              {(["7d", "30d"] as Period[]).map(p => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-2 py-0.5 text-[11px] font-semibold tracking-wide rounded transition-colors ${
                    period === p ? "bg-coral/20 text-coral" : "text-text-muted hover:text-text-secondary"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            <button
              onClick={handleSubmit}
              className="px-3 py-1.5 bg-coral/20 text-coral text-[11px] font-semibold tracking-wide rounded hover:bg-coral/30 transition-colors"
            >
              Lookup
            </button>
            {submittedAddr && (
              <button
                onClick={handleRefresh}
                className="px-2 py-1.5 text-text-muted hover:text-coral text-[11px] transition-colors"
              >
                Refresh
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Content */}
      {!submittedAddr ? (
        <div className="flex-1 overflow-hidden">
          <Leaderboard
            data={leaderboard}
            loading={lbLoading}
            period={period}
            onSelectWallet={(addr) => { setAddress(addr); doLookup(addr); }}
            onRefresh={() => {
              fetch("/api/leaderboard/refresh", { method: "POST" })
                .then(() => {
                  setLeaderboard(prev => prev ? { ...prev, scanning: true } : null);
                  // Poll for progress updates
                  const poll = setInterval(() => {
                    fetch("/api/leaderboard").then(r => r.json()).then((json: LeaderboardResponse) => {
                      setLeaderboard(json);
                      if (!json.scanning) clearInterval(poll);
                    }).catch(() => {});
                  }, 3000);
                })
                .catch(() => {});
            }}
          />
        </div>
      ) : loading ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-xs">
          <span className="loading-dots">Loading wallet data</span>
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-red text-xs">
          {error}
        </div>
      ) : hasNoActivity ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
          No Boros activity found for this address
        </div>
      ) : data ? (
        <div className="grid gap-0.5 flex-1 overflow-hidden grid-cols-[2fr_1fr_320px] grid-rows-2">
          {/* Positions table */}
          <Card className="overflow-auto">
            <CardHeader>
              <CardTitle>Positions</CardTitle>
              <span className="text-[10px] text-text-muted">{data.positions.length} open</span>
            </CardHeader>
            <CardContent>
              <PositionsTable positions={data.positions} nameMap={nameMap} />
            </CardContent>
          </Card>

          {/* Equity chart */}
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Equity</CardTitle>
              <span className="text-[10px] text-text-muted">
                {data.equityCurve.length > 0
                  ? `${fmtUsd(data.equityCurve[data.equityCurve.length - 1].equity)}`
                  : "--"}
              </span>
            </CardHeader>
            <CardContent className="p-1">
              <EquityChart points={data.equityCurve} period={period} />
            </CardContent>
          </Card>

          {/* Stats sidebar (spans 2 rows) */}
          <div className="row-span-2 overflow-auto">
            <StatsSidebar data={data} nameMap={nameMap} />
          </div>

          {/* Trading activity / market breakdown (bottom left, spanning 2 cols) */}
          <Card className="col-span-2 overflow-auto">
            <CardHeader>
              <CardTitle>Trading Activity</CardTitle>
              <span className="text-[10px] text-text-muted">
                {data.tradingActivity ? `${data.tradingActivity.totalOrders} orders` : "--"}
              </span>
            </CardHeader>
            <CardContent>
              {data.tradingActivity && data.tradingActivity.marketBreakdown.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Market</TableHead>
                      <TableHead className="text-right">Orders</TableHead>
                      <TableHead className="text-right">% of Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.tradingActivity.marketBreakdown.slice(0, 10).map(mb => {
                      const name = nameMap.get(mb.marketId) ?? `Market ${mb.marketId}`;
                      const pct = data.tradingActivity!.totalOrders > 0
                        ? (mb.count / data.tradingActivity!.totalOrders * 100).toFixed(1)
                        : "0";
                      return (
                        <TableRow key={mb.marketId}>
                          <TableCell className="text-coral font-semibold">{name}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums">{mb.count}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-text-muted">{pct}%</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <div className="flex items-center justify-center h-full text-text-muted text-xs py-4">
                  No trading activity
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
