import { useState, useEffect } from "react";
import { fmtApr } from "../utils/format";

interface OrderBookEntry {
  apr: number;
  notional: number;
}

interface MarketDetailProps {
  marketId: number;
}

export default function MarketDetail({ marketId }: MarketDetailProps) {
  const [bids, setBids] = useState<OrderBookEntry[]>([]);
  const [asks, setAsks] = useState<OrderBookEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/orderbook/${marketId}`)
      .then(r => r.json())
      .then((data: { bids?: Array<{ apr: number; notional: number }>; asks?: Array<{ apr: number; notional: number }> }) => {
        if (cancelled) return;
        const rawBids = (data.bids ?? []).slice(0, 3);
        const rawAsks = (data.asks ?? []).slice(0, 3);
        setBids(rawBids);
        setAsks(rawAsks);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [marketId]);

  if (loading) {
    return (
      <div className="text-[10px] text-text-muted p-2">Loading...</div>
    );
  }

  return (
    <div className="min-w-[180px]">
      <div className="text-[9px] font-semibold tracking-wide text-text-muted mb-1">ORDER BOOK</div>
      <div className="grid grid-cols-[1fr_1fr] gap-x-3 text-[10px] font-mono">
        <div>
          <div className="text-green text-[9px] font-semibold mb-0.5">BIDS</div>
          {bids.length === 0 ? (
            <div className="text-text-muted">--</div>
          ) : bids.map((b, i) => (
            <div key={i} className="flex justify-between gap-2">
              <span className="text-green">{fmtApr(b.apr)}</span>
              <span className="text-text-muted">{(b.notional / 1000).toFixed(0)}K</span>
            </div>
          ))}
        </div>
        <div>
          <div className="text-red text-[9px] font-semibold mb-0.5">ASKS</div>
          {asks.length === 0 ? (
            <div className="text-text-muted">--</div>
          ) : asks.map((a, i) => (
            <div key={i} className="flex justify-between gap-2">
              <span className="text-red">{fmtApr(a.apr)}</span>
              <span className="text-text-muted">{(a.notional / 1000).toFixed(0)}K</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
