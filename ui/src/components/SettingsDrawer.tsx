import { useState, useEffect, useCallback, useMemo } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "./ui/sheet";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { Info } from "lucide-react";

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
}

const SETTING_DESCRIPTIONS: Record<string, string> = {
  // Trading Parameters
  BOROS_MIN_EDGE_BPS: "Minimum edge in basis points to enter a new trade. Higher = more selective. Range: 50-500 bps.",
  BOROS_EXIT_EDGE_BPS: "Edge threshold in bps below which an open position is exited. Lower = hold longer. Range: 10-200 bps.",
  BOROS_AGGRESSIVE_ENTRY_BPS: "Edge threshold in bps for aggressive (taker) entries instead of passive (maker). Range: 200-600 bps.",
  BOROS_MAX_ENTRY_COST_BPS: "Maximum acceptable entry cost (spread + fees) in bps. Trades exceeding this are skipped. Range: 10-100 bps.",
  BOROS_SAFETY_BUFFER_BPS: "Extra buffer in bps added to minimum edge to account for slippage/execution risk. Range: 20-200 bps.",

  // Risk Management
  BOROS_MAX_DAILY_DRAWDOWN_PCT: "Maximum daily drawdown as a decimal (0.03 = 3%). Kill switch activates if exceeded. Range: 0.01-0.10.",
  BOROS_MAX_FAILURE_STREAK: "Number of consecutive failed order attempts before kill switch activates. Range: 1-10.",
  BOROS_MAX_EFFECTIVE_LEVERAGE: "Maximum effective leverage across all positions. Range: 1.0-5.0.",
  BOROS_MAX_CONCURRENT_MARKETS: "Maximum number of markets to hold positions in simultaneously. Range: 1-10.",
  BOROS_TAKE_PROFIT_PCT: "Take profit threshold as decimal of position PnL (0.25 = 25%). Range: 0.05-1.0.",
  BOROS_STOP_LOSS_PCT: "Stop loss threshold as decimal of position PnL (0.15 = 15%). Range: 0.05-0.50.",
  BOROS_TRAILING_STOP_ARM_PCT: "PnL percentage that arms the trailing stop (0.15 = 15% profit). Range: 0.05-0.50.",
  BOROS_TRAILING_STOP_GIVEBACK_PCT: "Maximum giveback from peak PnL before trailing stop triggers (0.10 = 10%). Range: 0.03-0.25.",

  // Position Sizing
  BOROS_MAX_INITIAL_MARGIN_PCT_PER_MARKET: "Maximum initial margin per market as fraction of equity (0.10 = 10%). Range: 0.02-0.25.",
  BOROS_MAX_TOTAL_INITIAL_MARGIN_PCT: "Maximum total initial margin across all positions as fraction of equity (0.35 = 35%). Range: 0.10-0.80.",
  BOROS_MARGIN_UTILIZATION_TARGET_PCT: "Target margin utilization rate (0.85 = 85% of budget). Controls position sizing aggressiveness. Range: 0.50-1.0.",
  BOROS_MIN_ORDER_NOTIONAL_USD: "Minimum notional value in USD for an order to be placed. Orders below this are skipped. Range: 1-100.",
  BOROS_STARTING_EQUITY_USD: "Starting equity in USD for paper trading mode. Only affects paper mode calculations.",

  // Execution
  BOROS_POLLING_INTERVAL_MS: "Milliseconds between trading cycles. Lower = more frequent checks. Range: 10000-300000 (10s-5m).",
  BOROS_MARKET_ORDER_SLIPPAGE: "Maximum slippage tolerance for taker orders as decimal (0.05 = 5%). Range: 0.01-0.20.",
  BOROS_CLIP_APR_WINDOW_BPS: "Window in bps for clipping outlier APR sources in fair value calculation. Range: 100-1000 bps.",
  BOROS_DRY_RUN: "When 'true', evaluates signals but does not execute any orders. Useful for testing.",
  BOROS_PAPER_ASSUME_TAKER_ENTRY: "When 'true', paper mode assumes taker fills (worst price). When 'false', assumes maker fills.",
  BOROS_MODE: "Trading mode: 'paper' for simulated execution, 'live' for real on-chain trades. Requires credentials for live.",

  // Isolated Markets
  BOROS_ALLOW_ISOLATED_MARKETS: "Allow trading in isolated-margin-only markets. Set 'true' or 'false'.",
  BOROS_AUTO_FUND_ISOLATED_MARKETS: "Automatically fund isolated margin accounts when opening positions. Set 'true' or 'false'.",
  BOROS_ISOLATED_MARGIN_BUFFER_BPS: "Extra margin buffer in bps when funding isolated accounts. Prevents immediate liquidation risk. Range: 200-1000.",
  BOROS_MIN_ISOLATED_CASH_TOPUP_USD: "Minimum cash top-up in USD for isolated margin funding. Range: 1-100.",

  // Order Management
  BOROS_AUTO_CANCEL_STALE_LIVE_ORDERS: "Automatically cancel live orders that exceed their TTL. Set 'true' or 'false'.",
  BOROS_LIVE_ENTRY_ORDER_TTL_SECONDS: "Time-to-live for entry orders in seconds before auto-cancel. Range: 60-3600.",
  BOROS_LIVE_EXIT_ORDER_TTL_SECONDS: "Time-to-live for exit orders in seconds before auto-cancel. Range: 30-600.",

  // Liquidity
  BOROS_MIN_LIQUIDITY_COVERAGE: "Minimum ratio of order book liquidity to position size required for entry. Range: 1-10.",
  BOROS_MIN_ENTRY_LIQ_BUFFER_BPS: "Minimum liquidation buffer in bps required to enter a position. Range: 100-1000.",
  BOROS_MIN_MAINTAIN_LIQ_BUFFER_BPS: "Minimum liquidation buffer in bps to maintain a position (below triggers exit). Range: 50-500.",
  BOROS_MIN_DAYS_TO_MATURITY: "Minimum days to maturity for a market to be eligible for new entries. Range: 1-90.",

  // Market Filter
  BOROS_ALLOWED_MARKET_IDS: "Comma-separated list of market IDs to trade. Empty = all whitelisted markets.",
  BOROS_MAX_MARKETS: "Maximum number of markets to fetch from the API. Range: 10-500.",

  // Copy Trade
  BOROS_COPY_TRADE_ENABLED: "Enable copy trading mode. When 'true', mirrors a target address's positions.",
  BOROS_COPY_TRADE_SIZE_RATIO: "Ratio of target's position size to copy (1.0 = same size, 0.5 = half). Range: 0.01-5.0.",
  BOROS_COPY_TRADE_MAX_NOTIONAL_USD: "Maximum notional USD per copy trade order. Caps exposure per trade. Range: 100-100000.",
  BOROS_COPY_TRADE_MAX_SLIPPAGE: "Maximum slippage for copy trade execution (0.10 = 10%). Range: 0.01-0.50.",
  BOROS_COPY_TRADE_POLLING_MS: "Milliseconds between polling for target position changes. Range: 5000-60000.",
  BOROS_COPY_TRADE_MIN_ORDER_NOTIONAL_USD: "Minimum notional for copy trade orders. Range: 1-100.",
  BOROS_COPY_TRADE_ROUND_UP_TO_MIN: "When 'true', rounds up sub-minimum orders to the minimum notional instead of skipping them. Default: true.",
  BOROS_COPY_TRADE_MAX_CONCURRENT_POSITIONS: "Maximum concurrent copy positions. Range: 1-20.",
  BOROS_COPY_TRADE_DELAY_BETWEEN_ORDERS_MS: "Delay in ms between successive copy trade orders. Prevents rapid-fire. Range: 100-5000.",
  BOROS_COPY_TRADE_DELTA_DEADZONE: "Minimum position size change to trigger a copy action (0.001 = 0.1%). Range: 0.0001-0.01.",
  BOROS_COPY_TRADE_MAX_FAILURE_STREAK: "Max consecutive copy trade failures before kill switch. Range: 1-20.",
  BOROS_COPY_TRADE_MAX_DAILY_DRAWDOWN_PCT: "Max daily drawdown for copy trading (0.05 = 5%). Range: 0.01-0.20.",
  BOROS_COPY_TRADE_MIN_LIQUIDITY_COVERAGE: "Minimum liquidity coverage for copy trade entries. Range: 1-10.",
};

const SECTIONS: Array<{ title: string; keys: string[] }> = [
  {
    title: "Trading Parameters",
    keys: ["BOROS_MODE", "BOROS_MIN_EDGE_BPS", "BOROS_EXIT_EDGE_BPS", "BOROS_AGGRESSIVE_ENTRY_BPS", "BOROS_MAX_ENTRY_COST_BPS", "BOROS_SAFETY_BUFFER_BPS"],
  },
  {
    title: "Risk Management",
    keys: ["BOROS_MAX_DAILY_DRAWDOWN_PCT", "BOROS_MAX_FAILURE_STREAK", "BOROS_MAX_EFFECTIVE_LEVERAGE", "BOROS_MAX_CONCURRENT_MARKETS", "BOROS_TAKE_PROFIT_PCT", "BOROS_STOP_LOSS_PCT", "BOROS_TRAILING_STOP_ARM_PCT", "BOROS_TRAILING_STOP_GIVEBACK_PCT"],
  },
  {
    title: "Position Sizing",
    keys: ["BOROS_MAX_INITIAL_MARGIN_PCT_PER_MARKET", "BOROS_MAX_TOTAL_INITIAL_MARGIN_PCT", "BOROS_MARGIN_UTILIZATION_TARGET_PCT", "BOROS_MIN_ORDER_NOTIONAL_USD", "BOROS_STARTING_EQUITY_USD"],
  },
  {
    title: "Execution",
    keys: ["BOROS_POLLING_INTERVAL_MS", "BOROS_MARKET_ORDER_SLIPPAGE", "BOROS_CLIP_APR_WINDOW_BPS", "BOROS_DRY_RUN", "BOROS_PAPER_ASSUME_TAKER_ENTRY"],
  },
  {
    title: "Liquidity & Maturity",
    keys: ["BOROS_MIN_LIQUIDITY_COVERAGE", "BOROS_MIN_ENTRY_LIQ_BUFFER_BPS", "BOROS_MIN_MAINTAIN_LIQ_BUFFER_BPS", "BOROS_MIN_DAYS_TO_MATURITY", "BOROS_ALLOWED_MARKET_IDS", "BOROS_MAX_MARKETS"],
  },
  {
    title: "Isolated Markets",
    keys: ["BOROS_ALLOW_ISOLATED_MARKETS", "BOROS_AUTO_FUND_ISOLATED_MARKETS", "BOROS_ISOLATED_MARGIN_BUFFER_BPS", "BOROS_MIN_ISOLATED_CASH_TOPUP_USD"],
  },
  {
    title: "Order Management",
    keys: ["BOROS_AUTO_CANCEL_STALE_LIVE_ORDERS", "BOROS_LIVE_ENTRY_ORDER_TTL_SECONDS", "BOROS_LIVE_EXIT_ORDER_TTL_SECONDS"],
  },
  {
    title: "Copy Trade",
    keys: ["BOROS_COPY_TRADE_ENABLED", "BOROS_COPY_TRADE_SIZE_RATIO", "BOROS_COPY_TRADE_MAX_NOTIONAL_USD", "BOROS_COPY_TRADE_MAX_SLIPPAGE", "BOROS_COPY_TRADE_POLLING_MS", "BOROS_COPY_TRADE_MIN_ORDER_NOTIONAL_USD", "BOROS_COPY_TRADE_ROUND_UP_TO_MIN", "BOROS_COPY_TRADE_MAX_CONCURRENT_POSITIONS", "BOROS_COPY_TRADE_DELAY_BETWEEN_ORDERS_MS", "BOROS_COPY_TRADE_DELTA_DEADZONE", "BOROS_COPY_TRADE_MAX_FAILURE_STREAK", "BOROS_COPY_TRADE_MAX_DAILY_DRAWDOWN_PCT", "BOROS_COPY_TRADE_MIN_LIQUIDITY_COVERAGE"],
  },
];

const SECTION_KEY_SET = new Set(SECTIONS.flatMap((s) => s.keys));

const CRITICAL_KEYS = new Set([
  "BOROS_MODE",
  "BOROS_MAX_DAILY_DRAWDOWN_PCT",
  "BOROS_MAX_FAILURE_STREAK",
  "BOROS_MAX_EFFECTIVE_LEVERAGE",
  "BOROS_COPY_TRADE_ENABLED",
  "BOROS_COPY_TRADE_SIZE_RATIO",
  "BOROS_COPY_TRADE_MAX_NOTIONAL_USD",
]);

function SettingTooltip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center justify-center size-3.5 rounded-full border border-text-muted/40 text-text-muted cursor-help shrink-0">
          <Info className="size-2.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{text}</TooltipContent>
    </Tooltip>
  );
}

export default function SettingsDrawer({ open, onClose }: SettingsDrawerProps) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saveMsg, setSaveMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingCritical, setPendingCritical] = useState<Record<string, { from: string; to: string }> | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const data = await res.json() as Record<string, string>;
      setSettings(data);
      setDraft(data);
    } catch { /* empty */ }
  }, []);

  useEffect(() => {
    if (open) fetchSettings();
  }, [open, fetchSettings]);

  const handleChange = (key: string, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const executeSave = async (changes: Record<string, string>) => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const data = await res.json() as { ok?: boolean; message?: string; error?: string };
      if (data.ok) {
        setSaveMsg(data.message ?? "Saved.");
        setSettings((prev) => ({ ...prev, ...changes }));
      } else {
        setSaveMsg(`Error: ${data.error ?? "Unknown error"}`);
      }
    } catch (err) {
      setSaveMsg(`Error: ${String(err)}`);
    }
    setLoading(false);
    setTimeout(() => setSaveMsg(""), 5000);
  };

  const handleSave = async () => {
    const changes: Record<string, string> = {};
    for (const [key, val] of Object.entries(draft)) {
      if (val !== settings[key]) {
        changes[key] = val;
      }
    }
    if (Object.keys(changes).length === 0) {
      setSaveMsg("No changes to save.");
      setTimeout(() => setSaveMsg(""), 3000);
      return;
    }

    // Check if any critical keys are being changed
    const criticalChanges: Record<string, { from: string; to: string }> = {};
    for (const [key, val] of Object.entries(changes)) {
      if (CRITICAL_KEYS.has(key)) {
        criticalChanges[key] = { from: settings[key] ?? "", to: val };
      }
    }

    if (Object.keys(criticalChanges).length > 0) {
      setPendingCritical(criticalChanges);
      return;
    }

    await executeSave(changes);
  };

  const changedKeys = useMemo(
    () => new Set(Object.entries(draft).filter(([k, v]) => v !== settings[k]).map(([k]) => k)),
    [draft, settings]
  );

  const renderFields = (keys: string[]) =>
    keys.filter((k) => k in draft).map((key) => (
      <div className="flex flex-col gap-1 mb-3" key={key}>
        <label className="flex items-center gap-1.5 text-[10px] text-text-muted tracking-wide">
          <span className={changedKeys.has(key) ? "text-coral" : undefined}>
            {key}
          </span>
          {SETTING_DESCRIPTIONS[key] && (
            <SettingTooltip text={SETTING_DESCRIPTIONS[key]} />
          )}
        </label>
        <input
          className="w-full bg-background border border-border text-text-primary font-mono text-xs px-2 py-1.5 outline-none focus:border-coral focus:ring-1 focus:ring-coral/30 transition-colors"
          value={draft[key] ?? ""}
          onChange={(e) => handleChange(key, e.target.value)}
        />
      </div>
    ));

  return (
    <TooltipProvider delayDuration={200}>
      <Sheet open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Settings</SheetTitle>
            <SheetDescription className="sr-only">Environment configuration settings</SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {SECTIONS.map((section) => {
              const sectionKeys = section.keys.filter((k) => k in draft);
              if (sectionKeys.length === 0) return null;
              return (
                <div className="mb-5" key={section.title}>
                  <h3 className="text-[11px] font-semibold tracking-[1.5px] uppercase text-coral mb-2 pb-1 border-b border-coral/20">
                    {section.title}
                  </h3>
                  {renderFields(sectionKeys)}
                </div>
              );
            })}

            {/* Uncategorized BOROS_ keys */}
            {(() => {
              const extraKeys = Object.keys(draft).filter(
                (k) => k.startsWith("BOROS_") && !SECTION_KEY_SET.has(k)
              );
              if (extraKeys.length === 0) return null;
              return (
                <div className="mb-5">
                  <h3 className="text-[11px] font-semibold tracking-[1.5px] uppercase text-coral mb-2 pb-1 border-b border-coral/20">
                    Other
                  </h3>
                  {renderFields(extraKeys)}
                </div>
              );
            })()}
          </div>

          {/* Critical settings confirmation overlay */}
          {pendingCritical && (
            <div className="mx-4 my-3 border-2 border-amber/60 bg-amber/10 rounded p-3">
              <p className="text-[11px] font-semibold text-amber mb-2">Confirm critical changes:</p>
              {Object.entries(pendingCritical).map(([key, { from, to }]) => (
                <div key={key} className="text-[10px] font-mono mb-1">
                  <span className="text-text-muted">{key}:</span>{" "}
                  <span className="text-red line-through">{from || "(empty)"}</span>{" "}
                  <span className="text-green">{to}</span>
                </div>
              ))}
              <div className="flex gap-2 mt-3">
                <Button
                  size="sm"
                  className="text-[10px] bg-amber/20 text-amber hover:bg-amber/30 border border-amber/40"
                  onClick={async () => {
                    const allChanges: Record<string, string> = {};
                    for (const [key, val] of Object.entries(draft)) {
                      if (val !== settings[key]) allChanges[key] = val;
                    }
                    setPendingCritical(null);
                    await executeSave(allChanges);
                  }}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-[10px]"
                  onClick={() => setPendingCritical(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="text-[10px] text-text-muted px-4 py-2 border-t border-border/50">
            Restart the trader process for changes to take effect.
          </div>
          <div className="flex items-center gap-3 px-4 py-3 border-t border-border">
            <Button onClick={handleSave} disabled={loading || !!pendingCritical} className="text-xs">
              {loading ? "Saving..." : `Save${changedKeys.size > 0 ? ` (${changedKeys.size})` : ""}`}
            </Button>
            {saveMsg && <span className="text-xs text-green animate-in fade-in">{saveMsg}</span>}
          </div>
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}
