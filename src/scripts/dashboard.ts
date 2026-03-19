import mongoose from "mongoose";
import http from "http";
import { connectDb } from "../db";
import { config } from "../config";
import { Job } from "../models/Job";
import { getTempDiskUsage } from "../services/bundler";
import { fmt } from "./fmt";

const REFRESH_MS = 1000;
const CLEAR = "\x1b[2J\x1b[H";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";

function checkApiUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://localhost:${config.port}/api/stats`,
      { timeout: 1500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function progressBar(current: number, total: number, width = 20): string {
  if (!total) return "";
  const pct = Math.min(current / total, 1);
  const filled = Math.round(pct * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `${bar} ${(pct * 100).toFixed(0)}%`;
}

function statusColor(status: string): string {
  switch (status) {
    case "pending": return YELLOW;
    case "processing": case "compressing": case "compressed": case "uploading": return CYAN;
    case "completed": return GREEN;
    case "failed": return RED;
    case "cancelled": return GRAY;
    default: return RESET;
  }
}

async function render() {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);
  const hd = (title: string) => push(`\n${BOLD}${CYAN}── ${title} ──${RESET}`);
  const kv = (label: string, value: string | number) => push(`  ${String(label).padEnd(22)} ${value}`);

  push(`${BOLD} LUNAR MELEE — Live Dashboard${RESET}          ${DIM}${new Date().toLocaleTimeString()}  (ctrl+c to exit)${RESET}`);

  // --- API status ---
  const apiUp = await checkApiUp();
  hd("Server");
  kv("API", apiUp ? `${GREEN}● running${RESET} on port ${config.port}` : `${RED}● down${RESET} (port ${config.port})`);

  // --- Infer worker state from job statuses ---
  const compressorJob = await Job.findOne({ status: { $in: ["processing", "compressing"] } })
    .select("_id status").lean();
  const uploaderJob = await Job.findOne({ status: "uploading" })
    .select("_id status").lean();

  if (apiUp) {
    kv("Compressor", compressorJob
      ? `${GREEN}● active${RESET}  job ...${compressorJob._id.toString().slice(-6)} ${DIM}(${compressorJob.status})${RESET}`
      : `${DIM}● idle${RESET}`);
    kv("Uploader", uploaderJob
      ? `${GREEN}● active${RESET}  job ...${uploaderJob._id.toString().slice(-6)}`
      : `${DIM}● idle${RESET}`);
  } else {
    kv("Workers", `${RED}● server not running${RESET}`);
  }

  // --- Temp disk ---
  try {
    const { usedBytes, freeBytes, entries } = await getTempDiskUsage();
    kv("Temp disk", `${fmt.bytes(usedBytes)} used / ${fmt.bytes(freeBytes)} free  (${entries} entries)`);
  } catch {}

  // --- Active Jobs ---
  const activeStatuses = ["processing", "compressing", "compressed", "uploading"];
  const activeJobs = await Job.find({ status: { $in: activeStatuses } })
    .select("status progress replayCount estimatedSize bundleSize startedAt filter")
    .sort({ startedAt: 1 })
    .lean();

  if (activeJobs.length > 0) {
    hd("Active");
    for (const j of activeJobs) {
      const id = j._id.toString().slice(-6);
      const elapsed = j.startedAt ? fmt.duration(Math.floor((Date.now() - j.startedAt.getTime()) / 1000)) : "?";

      let detail = `${statusColor(j.status)}${j.status.padEnd(12)}${RESET}`;

      if (j.progress && j.progress.filesTotal) {
        if (j.status === "uploading" && j.progress.bytesTotal) {
          detail += ` ${progressBar(j.progress.bytesUploaded || 0, j.progress.bytesTotal)}`;
          detail += `  ${fmt.bytes(j.progress.bytesUploaded || 0)} / ${fmt.bytes(j.progress.bytesTotal)}`;
        } else {
          detail += ` ${progressBar(j.progress.filesProcessed || 0, j.progress.filesTotal)}`;
          detail += `  ${fmt.num(j.progress.filesProcessed || 0)} / ${fmt.num(j.progress.filesTotal)} files`;
        }
      }

      // Filter summary
      const fp: string[] = [];
      if (j.filter.p1ConnectCode) fp.push(`p1=${j.filter.p1ConnectCode}`);
      if (j.filter.p2ConnectCode) fp.push(`p2=${j.filter.p2ConnectCode}`);
      if (j.filter.p1CharacterId != null) fp.push(`char=${j.filter.p1CharacterId}`);
      if (j.filter.stageId != null) fp.push(`stage=${j.filter.stageId}`);
      const filterStr = fp.length > 0 ? `  ${DIM}(${fp.join(", ")})${RESET}` : "";

      push(`  ${DIM}...${id}${RESET}  ${detail}  ${DIM}${elapsed}${RESET}${filterStr}`);
    }
  }

  // --- Pending Queue ---
  const pendingCount = await Job.countDocuments({ status: "pending" });
  if (pendingCount > 0) {
    hd(`Queue (${pendingCount} pending)`);
    const pending = await Job.find({ status: "pending" })
      .select("filter estimatedSize replayCount priority createdAt")
      .sort({ priority: 1, createdAt: 1 })
      .limit(5)
      .lean();

    for (const j of pending) {
      const id = j._id.toString().slice(-6);
      const fp: string[] = [];
      if (j.filter.p1ConnectCode) fp.push(`p1=${j.filter.p1ConnectCode}`);
      if (j.filter.p2ConnectCode) fp.push(`p2=${j.filter.p2ConnectCode}`);
      if (j.filter.p1CharacterId != null) fp.push(`char=${j.filter.p1CharacterId}`);
      if (j.filter.stageId != null) fp.push(`stage=${j.filter.stageId}`);
      const filterStr = fp.join(", ") || "no filter";
      const size = j.estimatedSize ? `~${fmt.bytes(j.estimatedSize)}` : "?";
      const replays = j.replayCount ? `${fmt.num(j.replayCount)} replays` : "?";
      push(`  ${DIM}...${id}${RESET}  ${YELLOW}pri=${j.priority}${RESET}  ${filterStr}  ${replays}  ${size}  ${DIM}${fmt.ago(j.createdAt)}${RESET}`);
    }
    if (pendingCount > 5) push(`  ${DIM}... and ${pendingCount - 5} more${RESET}`);
  }

  // --- Recent jobs (completed, failed, cancelled) ---
  const recentJobs = await Job.find({ status: { $in: ["completed", "failed", "cancelled"] } })
    .select("status replayCount bundleSize completedAt updatedAt downloadCount error createdBy")
    .sort({ updatedAt: -1 })
    .limit(5)
    .lean();

  if (recentJobs.length > 0) {
    hd("Recent Jobs");
    // Column widths
    const COL_ICON = 2;   // ✓/✗/⊘
    const COL_DETAIL = 42;
    const COL_WHEN = 10;

    for (const j of recentJobs) {
      const id = j._id.toString().slice(-6);
      const when = fmt.ago(j.updatedAt).padStart(COL_WHEN);

      let icon: string;
      let detail: string;

      if (j.status === "completed") {
        icon = `${GREEN}✓${RESET}`;
        const replays = `${fmt.num(j.replayCount || 0)} replays`;
        const size = j.bundleSize ? fmt.bytes(j.bundleSize) : "?";
        const dl = `${j.downloadCount || 0} dl`;
        detail = `${replays.padEnd(16)} ${size.padEnd(12)} ${dl}`;
      } else if (j.status === "cancelled") {
        icon = `${YELLOW}⊘${RESET}`;
        const who = j.createdBy ? `client ${j.createdBy.slice(0, 8)}` : "admin";
        detail = `cancelled by ${who}`;
      } else {
        icon = `${RED}✗${RESET}`;
        detail = j.error ? j.error.slice(0, COL_DETAIL) : "unknown error";
      }

      push(`  ${DIM}...${id}${RESET}  ${icon}  ${detail.padEnd(COL_DETAIL)}  ${DIM}${when}${RESET}`);
    }
  }

  push("");

  // Render
  process.stdout.write(CLEAR + lines.join("\n") + "\n");
}

async function main() {
  // Suppress mongoose connection log for clean dashboard
  const origLog = console.log;
  console.log = () => {};
  await connectDb();
  console.log = origLog;

  // Initial render
  await render();

  // Loop
  const interval = setInterval(async () => {
    try {
      await render();
    } catch (err: any) {
      process.stdout.write(`\n${RED}Error: ${err.message}${RESET}\n`);
    }
  }, REFRESH_MS);

  // Graceful shutdown
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
