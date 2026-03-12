#!/usr/bin/env tsx
/**
 * Boros CLI Wizard — single entry point for the entire system.
 *
 * Usage:
 *   npm run boros          Interactive wizard
 *   npm run boros -- --ui  Dashboard only (skip wizard)
 */

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { config as loadEnv } from "dotenv";

const ROOT = path.resolve(import.meta.dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");

// ── Helpers ──────────────────────────────────────────────────────────────

function readEnv(): Record<string, string> {
  if (!fs.existsSync(ENV_PATH)) return {};
  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return result;
}

function writeEnvKey(key: string, value: string): void {
  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, `${key}=${value}\n`, "utf-8");
    return;
  }
  const raw = fs.readFileSync(ENV_PATH, "utf-8");
  const lines = raw.split("\n");
  let found = false;
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq < 1) return line;
    if (trimmed.slice(0, eq).trim() === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) updated.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, updated.join("\n"), "utf-8");
}

function truncAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

// ── Readline prompt ──────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

async function choose(prompt: string, options: string[], defaultIdx = 0): Promise<number> {
  console.log();
  console.log(`  ${prompt}`);
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIdx ? "\x1b[33m>\x1b[0m" : " ";
    console.log(`  ${marker} ${i + 1}. ${options[i]}`);
  }
  const raw = await ask(`  Choice [${defaultIdx + 1}]: `);
  if (!raw) return defaultIdx;
  const idx = parseInt(raw, 10) - 1;
  if (idx >= 0 && idx < options.length) return idx;
  return defaultIdx;
}

async function confirm(prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const raw = await ask(`  ${prompt} ${hint}: `);
  if (!raw) return defaultYes;
  return raw.toLowerCase().startsWith("y");
}

async function input(prompt: string, defaultVal: string): Promise<string> {
  const raw = await ask(`  ${prompt} [${defaultVal}]: `);
  return raw || defaultVal;
}

// ── Banner ───────────────────────────────────────────────────────────────

function banner(): void {
  console.log();
  console.log("\x1b[33m  ____   ___  ____   ___  ____\x1b[0m");
  console.log("\x1b[33m | __ ) / _ \\|  _ \\ / _ \\/ ___|\x1b[0m");
  console.log("\x1b[33m |  _ \\| | | | |_) | | | \\___ \\\x1b[0m");
  console.log("\x1b[33m | |_) | |_| |  _ <| |_| |___) |\x1b[0m");
  console.log("\x1b[33m |____/ \\___/|_| \\_\\\\___/|____/\x1b[0m");
  console.log();
  console.log("  Pendle Boros Trading System");
  console.log("  ─────────────────────────────");
}

// ── Pre-flight checks ────────────────────────────────────────────────────

function checkCredentials(env: Record<string, string>, mode: string): string[] {
  const issues: string[] = [];
  if (mode === "live") {
    if (!env.BOROS_ROOT_ADDRESS) issues.push("BOROS_ROOT_ADDRESS not set");
    if (!env.BOROS_PRIVATE_KEY) issues.push("BOROS_PRIVATE_KEY not set");
    if (!env.BOROS_ACCOUNT_ID) issues.push("BOROS_ACCOUNT_ID not set");
    if (!env.BOROS_RPC_URL) issues.push("BOROS_RPC_URL not set");
  }
  return issues;
}

// ── Process management ───────────────────────────────────────────────────

const children: ChildProcess[] = [];

function spawnChild(cmd: string, args: string[], label: string, cwd?: string): ChildProcess {
  const child = spawn(cmd, args, {
    cwd: cwd ?? ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  child.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      console.log(`\x1b[2m[${label}]\x1b[0m ${line}`);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      console.log(`\x1b[31m[${label}]\x1b[0m ${line}`);
    }
  });

  child.on("exit", (code) => {
    console.log(`\x1b[2m[${label}] exited (code ${code})\x1b[0m`);
  });

  children.push(child);
  return child;
}

function cleanup(): void {
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
}

process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

// ── Main wizard ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load existing env
  loadEnv({ path: ENV_PATH });
  const env = readEnv();

  // Quick mode: --ui flag skips wizard, just starts dashboard
  if (process.argv.includes("--ui")) {
    console.log("\n  Starting dashboard...\n");
    spawnChild("npx", ["tsx", "server.ts"], "api", path.join(ROOT, "ui"));
    spawnChild("npx", ["vite", "--port", "5173"], "vite", path.join(ROOT, "ui"));
    console.log("\n  Dashboard: \x1b[36mhttp://localhost:5173\x1b[0m");
    console.log("  API:       \x1b[36mhttp://localhost:3142\x1b[0m\n");
    return; // keep running via child processes
  }

  // Resume mode: --resume skips wizard, launches bot + dashboard with existing config
  if (process.argv.includes("--resume")) {
    banner();
    const isCopy = env.BOROS_COPY_TRADE_ENABLED === "true";
    const mode = env.BOROS_MODE ?? "paper";
    console.log(`  Resuming: ${isCopy ? "Copy Trade" : "Strategy"} / ${mode}`);
    if (isCopy && env.BOROS_COPY_TRADE_TARGET_ADDRESS) {
      console.log(`  Target:   ${truncAddr(env.BOROS_COPY_TRADE_TARGET_ADDRESS)}`);
    }
    console.log();

    spawnChild("npx", ["tsx", "server.ts"], "api", path.join(ROOT, "ui"));
    spawnChild("npx", ["vite", "--port", "5173"], "vite", path.join(ROOT, "ui"));
    console.log("  Dashboard: \x1b[36mhttp://localhost:5173\x1b[0m");
    console.log("  API:       \x1b[36mhttp://localhost:3142\x1b[0m");

    const botArgs = ["tsx", "src/index.ts"];
    if (process.argv.includes("--once")) botArgs.push("--once");
    console.log(`  Bot:       npx ${botArgs.join(" ")}`);
    console.log();

    spawnChild("npx", botArgs, "bot");
    return;
  }

  banner();

  // Detect current config
  const currentMode = env.BOROS_MODE ?? "paper";
  const currentCopy = env.BOROS_COPY_TRADE_ENABLED === "true";
  const currentTarget = env.BOROS_COPY_TRADE_TARGET_ADDRESS ?? "";

  console.log(`  Current: ${currentCopy ? "Copy Trade" : "Strategy"} / ${currentMode}`);
  if (currentCopy && currentTarget) {
    console.log(`  Target:  ${truncAddr(currentTarget)}`);
  }

  // ── Step 1: Choose strategy ──
  const stratIdx = await choose("What do you want to run?", [
    "Strategy Bot  — relative value trading (scan for edge, enter/exit automatically)",
    "Copy Trader   — follow another wallet's positions",
    "Dashboard     — monitoring UI only (no trading)",
  ], currentCopy ? 1 : 0);

  if (stratIdx === 2) {
    // Dashboard only
    console.log("\n  Starting dashboard...\n");
    writeEnvKey("BOROS_COPY_TRADE_ENABLED", currentCopy ? "true" : "false");
    spawnChild("npx", ["tsx", "server.ts"], "api", path.join(ROOT, "ui"));
    spawnChild("npx", ["vite", "--port", "5173"], "vite", path.join(ROOT, "ui"));
    console.log("  Dashboard: \x1b[36mhttp://localhost:5173\x1b[0m");
    console.log("  API:       \x1b[36mhttp://localhost:3142\x1b[0m\n");
    rl.close();
    return;
  }

  const isCopy = stratIdx === 1;

  // ── Step 2: Paper or Live ──
  const modeIdx = await choose("Execution mode?", [
    "Paper  — simulated fills, no real orders",
    "Live   — real on-chain orders via Boros SDK",
  ], currentMode === "live" ? 1 : 0);

  const mode = modeIdx === 0 ? "paper" : "live";

  // Pre-flight for live
  if (mode === "live") {
    const issues = checkCredentials(env, mode);
    if (issues.length > 0) {
      console.log("\n  \x1b[31mMissing credentials for live mode:\x1b[0m");
      for (const issue of issues) {
        console.log(`    - ${issue}`);
      }
      console.log("\n  Add them to .env and try again.");
      rl.close();
      process.exit(1);
    }
  }

  // ── Step 3: Strategy-specific config ──

  if (isCopy) {
    // Copy trade settings
    const target = await input("Target address to copy", currentTarget || "0x...");
    const sizeRatio = await input("Size ratio (1.0 = match target)", env.BOROS_COPY_TRADE_SIZE_RATIO ?? "1.0");
    const maxNotional = await input("Max notional per position (USD)", env.BOROS_COPY_TRADE_MAX_NOTIONAL_USD ?? "5000");
    const maxSlippage = await input("Max APR slippage", env.BOROS_COPY_TRADE_MAX_SLIPPAGE ?? "0.10");

    writeEnvKey("BOROS_MODE", mode);
    writeEnvKey("BOROS_COPY_TRADE_ENABLED", "true");
    writeEnvKey("BOROS_COPY_TRADE_TARGET_ADDRESS", target);
    writeEnvKey("BOROS_COPY_TRADE_SIZE_RATIO", sizeRatio);
    writeEnvKey("BOROS_COPY_TRADE_MAX_NOTIONAL_USD", maxNotional);
    writeEnvKey("BOROS_COPY_TRADE_MAX_SLIPPAGE", maxSlippage);
  } else {
    // Strategy settings
    const equity = await input("Starting equity (USD)", env.BOROS_STARTING_EQUITY_USD ?? "100000");
    const minEdge = await input("Min edge to enter (bps)", env.BOROS_MIN_EDGE_BPS ?? "150");
    const exitEdge = await input("Exit when edge falls below (bps)", env.BOROS_EXIT_EDGE_BPS ?? "50");
    const maxLeverage = await input("Max leverage", env.BOROS_MAX_EFFECTIVE_LEVERAGE ?? "1.5");
    const maxMarkets = await input("Max concurrent positions", env.BOROS_MAX_CONCURRENT_MARKETS ?? "3");

    writeEnvKey("BOROS_MODE", mode);
    writeEnvKey("BOROS_COPY_TRADE_ENABLED", "false");
    writeEnvKey("BOROS_STARTING_EQUITY_USD", equity);
    writeEnvKey("BOROS_MIN_EDGE_BPS", minEdge);
    writeEnvKey("BOROS_EXIT_EDGE_BPS", exitEdge);
    writeEnvKey("BOROS_MAX_EFFECTIVE_LEVERAGE", maxLeverage);
    writeEnvKey("BOROS_MAX_CONCURRENT_MARKETS", maxMarkets);
  }

  // ── Step 4: Confirm and launch ──

  const startDashboard = await confirm("Start dashboard alongside bot?", true);
  const runOnce = await confirm("Single cycle only (test run)?", false);

  // Summary
  console.log();
  console.log("  \x1b[33m── Launch Summary ──\x1b[0m");
  console.log(`  Strategy:   ${isCopy ? "Copy Trade" : "Relative Value"}`);
  console.log(`  Mode:       ${mode}`);
  if (isCopy) {
    console.log(`  Target:     ${truncAddr(readEnv().BOROS_COPY_TRADE_TARGET_ADDRESS ?? "")}`);
    console.log(`  Size ratio: ${readEnv().BOROS_COPY_TRADE_SIZE_RATIO ?? "1.0"}x`);
    console.log(`  Max notl:   $${readEnv().BOROS_COPY_TRADE_MAX_NOTIONAL_USD ?? "5000"}`);
  } else {
    console.log(`  Equity:     $${readEnv().BOROS_STARTING_EQUITY_USD ?? "100000"}`);
    console.log(`  Min edge:   ${readEnv().BOROS_MIN_EDGE_BPS ?? "150"} bps`);
    console.log(`  Max lever:  ${readEnv().BOROS_MAX_EFFECTIVE_LEVERAGE ?? "1.5"}x`);
  }
  console.log(`  Dashboard:  ${startDashboard ? "yes" : "no"}`);
  console.log(`  Run once:   ${runOnce ? "yes" : "no"}`);
  console.log();

  const go = await confirm("Launch?", true);
  if (!go) {
    console.log("  Aborted.");
    rl.close();
    process.exit(0);
  }

  rl.close();
  console.log();

  // ── Launch processes ──

  if (startDashboard) {
    spawnChild("npx", ["tsx", "server.ts"], "api", path.join(ROOT, "ui"));
    spawnChild("npx", ["vite", "--port", "5173"], "vite", path.join(ROOT, "ui"));
    console.log("  Dashboard: \x1b[36mhttp://localhost:5173\x1b[0m");
    console.log("  API:       \x1b[36mhttp://localhost:3142\x1b[0m");
  }

  // Start the bot
  const botArgs = ["tsx", "src/index.ts"];
  if (runOnce) botArgs.push("--once");
  console.log(`  Bot:       npx ${botArgs.join(" ")}`);
  console.log();

  const bot = spawnChild("npx", botArgs, "bot");

  // If run-once, wait for bot to exit then clean up
  if (runOnce) {
    bot.on("exit", (code) => {
      console.log(`\n  Bot finished (exit ${code}). Press Ctrl+C to stop dashboard.`);
      if (!startDashboard) {
        cleanup();
        process.exit(code ?? 0);
      }
    });
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  cleanup();
  process.exit(1);
});
