import { useState, useEffect } from "react";
import { usePolling } from "./hooks/usePolling";
import type { MarketsResponse, PositionRow, OrderRow, SignalRow, KillEventRow, AppState } from "./types";
import Header from "./components/Header";
import MarketGrid from "./components/MarketGrid";
import Positions from "./components/Positions";
import EdgeScanner from "./components/EdgeScanner";
import ActivityLog from "./components/ActivityLog";
import SettingsDrawer from "./components/SettingsDrawer";

const POLL_FAST = 5_000;
const POLL_SLOW = 10_000;

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  const markets = usePolling<MarketsResponse>("/api/markets", POLL_FAST);
  const positions = usePolling<PositionRow[]>("/api/positions", POLL_FAST);
  const orders = usePolling<OrderRow[]>("/api/orders", POLL_SLOW);
  const signals = usePolling<SignalRow[]>("/api/signals", POLL_SLOW);
  const killEvents = usePolling<KillEventRow[]>("/api/kill-events", POLL_SLOW);
  const appState = usePolling<AppState>("/api/state", POLL_SLOW);

  // ESC to close drawer
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  return (
    <div className="app-shell">
      <Header
        state={appState.data}
        markets={markets.data}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="dashboard dashboard--with-log">
        <MarketGrid
          markets={markets.data}
          loading={markets.loading}
          lastUpdated={markets.lastUpdated}
        />

        <Positions
          positions={positions.data}
          loading={positions.loading}
          lastUpdated={positions.lastUpdated}
        />

        <ActivityLog
          orders={orders.data}
          killEvents={killEvents.data}
          loading={orders.loading}
        />

        <EdgeScanner
          signals={signals.data}
          loading={signals.loading}
          lastUpdated={signals.lastUpdated}
        />
      </div>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
