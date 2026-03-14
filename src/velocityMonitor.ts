import WebSocket from "ws";

export interface VelocityConfig {
  enabled: boolean;
  windowMs: number;
  thresholdPct: number;
  alertCooldownMs: number;
  reconnectDelayMs: number;
}

export interface VelocityAlert {
  asset: string;
  currentPrice: number;
  oldPrice: number;
  pctMove: number;
  direction: "UP" | "DOWN";
  triggeredAt: number;
}

interface PriceEntry {
  price: number;
  timestamp: number;
}

const DEFAULT_CONFIG: VelocityConfig = {
  enabled: true,
  windowMs: 120_000,
  thresholdPct: 0.03,
  alertCooldownMs: 300_000,
  reconnectDelayMs: 5_000,
};

const WS_URL = "wss://api.hyperliquid.xyz/ws";

export class VelocityMonitor {
  private readonly config: VelocityConfig;
  private ws: WebSocket | null = null;
  private priceWindows: Map<string, PriceEntry[]> = new Map();
  private activeAlerts: Map<string, VelocityAlert> = new Map();
  private assetMap: Map<string, number[]> = new Map();
  private marketIdToAsset: Map<number, string> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(config?: Partial<VelocityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setAssetMap(map: Map<string, number[]>): void {
    this.assetMap = new Map(map);
    this.marketIdToAsset.clear();
    for (const [asset, marketIds] of this.assetMap) {
      for (const id of marketIds) {
        this.marketIdToAsset.set(id, asset);
      }
    }
    console.log(
      `[velocity] asset map updated: tracking ${this.assetMap.size} assets across ${this.marketIdToAsset.size} market IDs`,
    );
  }

  start(): void {
    if (!this.config.enabled) {
      console.log("[velocity] monitor disabled by config, not starting");
      return;
    }
    if (this.running) {
      console.log("[velocity] already running");
      return;
    }
    this.running = true;
    console.log(
      `[velocity] starting monitor (window=${this.config.windowMs}ms, threshold=${(this.config.thresholdPct * 100).toFixed(2)}%, cooldown=${this.config.alertCooldownMs}ms)`,
    );
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    console.log("[velocity] monitor stopped");
  }

  getAlert(asset: string): VelocityAlert | null {
    this.pruneExpiredAlerts();
    return this.activeAlerts.get(asset) ?? null;
  }

  getAlertForMarket(marketId: number): VelocityAlert | null {
    this.pruneExpiredAlerts();
    const asset = this.marketIdToAsset.get(marketId);
    if (!asset) return null;

    // Check by asset name first
    const alert = this.activeAlerts.get(asset);
    if (alert) return alert;

    // Handle XAU -> PAXG mapping: if the marketId maps to "XAU", also check "PAXG"
    // and vice versa
    if (asset === "XAU") {
      return this.activeAlerts.get("PAXG") ?? null;
    }
    if (asset === "PAXG") {
      return this.activeAlerts.get("XAU") ?? null;
    }

    return null;
  }

  hasActiveAlerts(): boolean {
    this.pruneExpiredAlerts();
    return this.activeAlerts.size > 0;
  }

  getAllAlerts(): VelocityAlert[] {
    this.pruneExpiredAlerts();
    return Array.from(this.activeAlerts.values());
  }

  private connect(): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(WS_URL);
    } catch (err) {
      console.log(`[velocity] failed to create WebSocket: ${err}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      console.log("[velocity] WebSocket connected");
      this.subscribe();
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      try {
        this.handleMessage(data);
      } catch (err) {
        // Don't crash on malformed messages
        console.log(`[velocity] error handling message: ${err}`);
      }
    });

    this.ws.on("close", () => {
      console.log("[velocity] WebSocket disconnected");
      this.ws = null;
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.log(`[velocity] WebSocket error: ${err.message}`);
      // The 'close' event will fire after 'error', triggering reconnect
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const subscriptionMsg = JSON.stringify({
      method: "subscribe",
      subscription: { type: "allMids" },
    });
    this.ws.send(subscriptionMsg);
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectTimer) return;

    console.log(
      `[velocity] reconnecting in ${this.config.reconnectDelayMs}ms...`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.config.reconnectDelayMs);
  }

  private handleMessage(data: WebSocket.RawData): void {
    const msg = JSON.parse(data.toString());

    // allMids channel sends: { channel: "allMids", data: { mids: { "BTC": "63245.5", ... } } }
    if (msg.channel !== "allMids" || !msg.data?.mids) return;

    const now = Date.now();
    const mids: Record<string, string> = msg.data.mids;

    for (const [symbol, priceStr] of Object.entries(mids)) {
      const hlSymbol = this.resolveHlSymbol(symbol);
      if (!this.isTrackedAsset(hlSymbol)) continue;

      const price = parseFloat(priceStr);
      if (isNaN(price) || price <= 0) continue;

      this.updatePriceWindow(hlSymbol, price, now);
      this.checkVelocity(hlSymbol, price, now);
    }
  }

  /**
   * Resolve HL symbol for asset mapping. XAU maps to PAXG on HL,
   * so if we see "PAXG" from HL, we treat it as both PAXG and check XAU alerts.
   */
  private resolveHlSymbol(symbol: string): string {
    return symbol;
  }

  private isTrackedAsset(symbol: string): boolean {
    if (this.assetMap.size === 0) return false; // no map yet — don't track anything
    if (this.assetMap.has(symbol)) return true;
    // Check XAU/PAXG special mapping
    if (symbol === "PAXG" && this.assetMap.has("XAU")) return true;
    return false;
  }

  private updatePriceWindow(symbol: string, price: number, now: number): void {
    let window = this.priceWindows.get(symbol);
    if (!window) {
      window = [];
      this.priceWindows.set(symbol, window);
    }

    window.push({ price, timestamp: now });

    // Prune entries older than the rolling window
    const cutoff = now - this.config.windowMs;
    while (window.length > 0 && window[0].timestamp < cutoff) {
      window.shift();
    }
  }

  private checkVelocity(symbol: string, currentPrice: number, now: number): void {
    const window = this.priceWindows.get(symbol);
    if (!window || window.length < 2) return;

    const oldest = window[0];
    const pctMove = (currentPrice - oldest.price) / oldest.price;
    const absPctMove = Math.abs(pctMove);

    if (absPctMove < this.config.thresholdPct) return;

    // Check if we already have an active (non-expired) alert for this asset
    const existingAlert = this.activeAlerts.get(symbol);
    if (existingAlert && now - existingAlert.triggeredAt < this.config.alertCooldownMs) {
      return; // Still in cooldown
    }

    const direction: "UP" | "DOWN" = pctMove > 0 ? "UP" : "DOWN";

    const alert: VelocityAlert = {
      asset: symbol,
      currentPrice,
      oldPrice: oldest.price,
      pctMove,
      direction,
      triggeredAt: now,
    };

    this.activeAlerts.set(symbol, alert);

    // Also set alert under mapped name for XAU/PAXG
    if (symbol === "PAXG" && this.assetMap.has("XAU")) {
      this.activeAlerts.set("XAU", { ...alert, asset: "XAU" });
      console.log(
        `[velocity] ALERT: XAU (via PAXG) moved ${direction} ${(absPctMove * 100).toFixed(2)}% in ${this.config.windowMs / 1000}s ($${oldest.price.toFixed(2)} -> $${currentPrice.toFixed(2)})`,
      );
    }

    console.log(
      `[velocity] ALERT: ${symbol} moved ${direction} ${(absPctMove * 100).toFixed(2)}% in ${this.config.windowMs / 1000}s ($${oldest.price.toFixed(2)} -> $${currentPrice.toFixed(2)})`,
    );
  }

  private pruneExpiredAlerts(): void {
    const now = Date.now();
    for (const [asset, alert] of this.activeAlerts) {
      if (now - alert.triggeredAt >= this.config.alertCooldownMs) {
        this.activeAlerts.delete(asset);
        console.log(`[velocity] alert expired for ${asset}`);
      }
    }
  }
}
