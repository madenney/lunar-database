import mongoose from "mongoose";
import fs from "fs";
import { connectDb } from "../db";
import { Replay } from "../models/Replay";
import { fmt } from "./fmt";

const REFRESH_MS = 2000;
const CLEAR = "\x1b[2J\x1b[H";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";

const LOG_FILE = "crawl.log";

let startCount = 0;
let startTime = Date.now();
let lastCount = 0;
let lastTime = Date.now();

function progressBar(current: number, total: number, width = 30): string {
  if (!total) return "";
  const pct = Math.min(current / total, 1);
  const filled = Math.round(pct * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `${bar} ${(pct * 100).toFixed(1)}%`;
}

function tailLog(lines = 5): string[] {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf-8");
    return content.trim().split("\n").slice(-lines);
  } catch {
    return ["(no crawl.log found)"];
  }
}

async function render() {
  const now = Date.now();
  const count = await Replay.estimatedDocumentCount();

  // Rate calculation
  const elapsed = (now - startTime) / 1000;
  const intervalElapsed = (now - lastTime) / 1000;
  const overallRate = elapsed > 0 ? (count - startCount) / elapsed : 0;
  const recentRate = intervalElapsed > 0 ? (count - lastCount) / intervalElapsed : 0;

  // ETA (use overall rate for stability)
  const TARGET = 3_000_000;
  const remaining = TARGET - count;
  const etaSec = overallRate > 0 ? remaining / overallRate : 0;

  lastCount = count;
  lastTime = now;

  const lines: string[] = [];
  const push = (s = "") => lines.push(s);
  const kv = (label: string, value: string | number) => push(`  ${String(label).padEnd(22)} ${value}`);

  push(`${BOLD} CRAWL MONITOR${RESET}          ${DIM}${new Date().toLocaleTimeString()}  (ctrl+c to exit)${RESET}`);
  push("");

  push(`  ${progressBar(count, TARGET)}`);
  push("");

  kv("Replays indexed", `${BOLD}${fmt.num(count)}${RESET} / ~${fmt.num(TARGET)}`);
  kv("Elapsed", fmt.duration(Math.floor(elapsed)));
  kv("Rate (overall)", `${GREEN}${fmt.num(Math.round(overallRate))}/s${RESET}`);
  kv("Rate (recent)", `${CYAN}${fmt.num(Math.round(recentRate))}/s${RESET}`);

  if (remaining > 0 && overallRate > 0) {
    kv("ETA", `${YELLOW}${fmt.duration(Math.round(etaSec))}${RESET}`);
  } else if (remaining <= 0) {
    kv("Status", `${GREEN}DONE${RESET}`);
  }

  push("");
  push(`${DIM}── crawl.log (last 5 lines) ──${RESET}`);
  for (const line of tailLog(5)) {
    push(`  ${DIM}${line}${RESET}`);
  }

  push("");
  process.stdout.write(CLEAR + lines.join("\n") + "\n");
}

async function main() {
  const origLog = console.log;
  console.log = () => {};
  await connectDb();
  console.log = origLog;

  startCount = await Replay.estimatedDocumentCount();
  lastCount = startCount;
  startTime = Date.now();
  lastTime = startTime;

  await render();

  const interval = setInterval(async () => {
    try { await render(); } catch {}
  }, REFRESH_MS);

  const cleanup = async () => {
    clearInterval(interval);
    await mongoose.disconnect();
    process.stdout.write("\n");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
