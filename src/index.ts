import { BorosApiClient } from "./borosApi.js";
import { loadConfig } from "./config.js";
import { CopyTrader } from "./copyTrade.js";
import { RuntimeStore } from "./db.js";
import { RelativeValueTrader } from "./engine.js";
import type { CycleSummary } from "./types.js";

function printCycleSummary(summary: CycleSummary): void {
  console.log(`[boros] markets fetched=${summary.fetchedMarkets} eligible=${summary.eligibleMarkets} snapshotted=${summary.snapshotMarkets} open_positions=${summary.openPositions}`);

  if (summary.killSwitchActive) {
    console.log("[boros] kill switch active");
  }

  if (summary.snapshotErrors.length > 0) {
    console.log("[boros] snapshot errors:");
    for (const error of summary.snapshotErrors.slice(0, 5)) {
      console.log(`  - ${error}`);
    }
  }

  if (summary.topEdges.length > 0) {
    console.log("[boros] top edges:");
    for (const edge of summary.topEdges) {
      const netPart = edge.netEdgeBps === undefined ? "n/a" : `${edge.netEdgeBps.toFixed(1)}bps`;
      const actionPart = edge.action ?? "SKIP";
      const reasonPart = edge.reason ? ` reason=${edge.reason}` : "";
      console.log(
        `  - ${edge.marketName} side=${edge.side} action=${actionPart} raw=${edge.edgeBps.toFixed(1)}bps net=${netPart} fair=${edge.fairApr.toFixed(4)} mid=${edge.midApr.toFixed(4)}${reasonPart}`,
      );
    }
  }

  if (summary.skipReasonCounts.length > 0) {
    console.log("[boros] skip reasons:");
    for (const item of summary.skipReasonCounts.slice(0, 5)) {
      console.log(`  - ${item.reason}: ${item.count}`);
    }
  }

  if (summary.actions.length > 0) {
    console.log("[boros] actions:");
    for (const action of summary.actions) {
      console.log(
        `  - ${action.marketName} ${action.label} ${action.side} intent=${action.intent} status=${action.orderStatus} fill=${action.fillApr.toFixed(4)} net=${action.netEdgeBps.toFixed(1)}bps`,
      );
    }
  } else {
    console.log("[boros] actions: none");
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new RuntimeStore(config.sqlitePath);
  const api = new BorosApiClient({ baseUrl: config.apiBaseUrl });
  const runOnceOnly = process.argv.includes("--once") || process.env.BOROS_RUN_ONCE === "true";

  console.log(`[boros] mode=${config.mode} db=${config.sqlitePath}`);

  if (config.copyTrade.enabled) {
    const copyTrader = new CopyTrader(config, api, store);

    process.on("SIGINT", async () => {
      await copyTrader.stop();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      await copyTrader.stop();
      process.exit(0);
    });

    if (runOnceOnly) {
      await copyTrader.runOnce();
    } else {
      await copyTrader.start();
    }
    return;
  }

  const trader = new RelativeValueTrader(config, api, store);

  const run = async () => {
    try {
      const summary = await trader.runOnce();
      printCycleSummary(summary);
      console.log(`[boros] cycle complete at ${new Date().toISOString()}`);
    } catch (error) {
      console.error("[boros] cycle failed", error);
    }
  };

  await run();
  if (runOnceOnly) {
    return;
  }
  setInterval(run, config.pollingIntervalMs);
}

main().catch((error) => {
  console.error("[boros] fatal error", error);
  process.exitCode = 1;
});
