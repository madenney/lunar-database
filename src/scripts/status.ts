import mongoose from "mongoose";
import { connectDb } from "../db";
import { config } from "../config";
import { Replay } from "../models/Replay";
import { Job } from "../models/Job";
import { Player } from "../models/Player";
import { Submission } from "../models/Submission";
import { Upload } from "../models/Upload";
import { getTempDiskUsage } from "../services/bundler";
import { fmt, heading, row } from "./fmt";
import http from "http";

/** Try to hit the local API to check if the server is running */
function checkApi(): Promise<{ running: boolean; workers?: any }> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${config.port}/api/stats`, { timeout: 2000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({ running: true });
      });
    });
    req.on("error", () => resolve({ running: false }));
    req.on("timeout", () => { req.destroy(); resolve({ running: false }); });
  });
}

async function main() {
  await connectDb();

  // --- API Server ---
  heading("API Server");
  const api = await checkApi();
  if (api.running) {
    row("Status", "\x1b[32mRunning\x1b[0m on port " + config.port);
  } else {
    row("Status", "\x1b[31mNot running\x1b[0m (port " + config.port + ")");
  }

  // --- Database ---
  heading("Database");
  const [replayCount, playerCount, jobCount, submissionCount, uploadCount] = await Promise.all([
    Replay.countDocuments(),
    Player.countDocuments(),
    Job.countDocuments(),
    Submission.countDocuments(),
    Upload.countDocuments(),
  ]);
  row("Replays", fmt.num(replayCount));
  row("Players", fmt.num(playerCount));
  row("Jobs (all time)", fmt.num(jobCount));
  row("Submissions", fmt.num(submissionCount));
  row("Uploads", fmt.num(uploadCount));

  // Replay size stats
  const sizeAgg = await Replay.aggregate([
    { $group: { _id: null, totalSize: { $sum: "$fileSize" } } },
  ]);
  if (sizeAgg.length > 0 && sizeAgg[0].totalSize) {
    row("Total replay size", fmt.bytes(sizeAgg[0].totalSize));
  }

  // --- Jobs by Status ---
  heading("Jobs");
  const jobsByStatus = await Job.aggregate([
    { $group: { _id: "$status", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  const statusOrder = ["pending", "processing", "compressing", "compressed", "uploading", "completed", "failed", "cancelled"];
  const statusMap = new Map(jobsByStatus.map((j) => [j._id, j.count]));
  for (const s of statusOrder) {
    const count = statusMap.get(s) || 0;
    if (count > 0) {
      const color = s === "failed" ? "\x1b[31m" : s === "completed" ? "\x1b[32m" : s === "pending" ? "\x1b[33m" : "\x1b[0m";
      row(s, `${color}${fmt.num(count)}\x1b[0m`);
    }
  }
  if (jobsByStatus.length === 0) {
    row("(none)", "No jobs found");
  }

  // --- Active/In-Progress Jobs ---
  const activeStatuses = ["processing", "compressing", "compressed", "uploading"];
  const activeJobs = await Job.find({ status: { $in: activeStatuses } })
    .select("status progress replayCount bundleSize startedAt createdAt filter")
    .sort({ startedAt: 1 })
    .lean();

  if (activeJobs.length > 0) {
    heading("Active Jobs");
    for (const j of activeJobs) {
      const id = j._id.toString().slice(-6);
      const started = j.startedAt ? fmt.ago(j.startedAt) : "not started";
      let detail = `[${j.status}]`;
      if (j.progress) {
        detail += ` ${j.progress.filesProcessed}/${j.progress.filesTotal} files`;
      }
      if (j.replayCount) {
        detail += ` (${fmt.num(j.replayCount)} replays)`;
      }
      console.log(`  ...${id}  ${detail}  started ${started}`);
    }
  }

  // --- Pending Queue ---
  const pendingCount = statusMap.get("pending") || 0;
  if (pendingCount > 0) {
    heading("Queue (next 5)");
    const pendingJobs = await Job.find({ status: "pending" })
      .select("filter replayCount estimatedSize createdAt createdBy priority")
      .sort({ priority: 1, createdAt: 1 })
      .limit(5)
      .lean();
    for (const j of pendingJobs) {
      const id = j._id.toString().slice(-6);
      const filterParts: string[] = [];
      if (j.filter.p1ConnectCode) filterParts.push(`p1=${j.filter.p1ConnectCode}`);
      if (j.filter.p2ConnectCode) filterParts.push(`p2=${j.filter.p2ConnectCode}`);
      if (j.filter.p1CharacterId) filterParts.push(`char=${j.filter.p1CharacterId}`);
      if (j.filter.stageId) filterParts.push(`stage=${j.filter.stageId}`);
      const filterStr = filterParts.length > 0 ? filterParts.join(", ") : "no filter";
      const size = j.estimatedSize ? fmt.bytes(j.estimatedSize) : "?";
      console.log(`  ...${id}  pri=${j.priority}  ${filterStr}  ~${size}  ${fmt.ago(j.createdAt)}`);
    }
    if (pendingCount > 5) {
      console.log(`  ... and ${pendingCount - 5} more`);
    }
  }

  // --- Recent Failures ---
  const recentFailed = await Job.find({ status: "failed" })
    .select("error createdAt updatedAt")
    .sort({ updatedAt: -1 })
    .limit(3)
    .lean();

  if (recentFailed.length > 0) {
    heading("Recent Failures");
    for (const j of recentFailed) {
      const id = j._id.toString().slice(-6);
      const when = fmt.ago(j.updatedAt);
      const err = j.error ? j.error.slice(0, 80) : "unknown";
      console.log(`  ...${id}  ${when}  ${err}`);
    }
  }

  // --- Disk Usage ---
  heading("Disk");
  try {
    const { usedBytes, freeBytes, entries } = await getTempDiskUsage();
    row("Temp dir", config.jobTempDir);
    row("Temp entries", fmt.num(entries));
    row("Temp used", fmt.bytes(usedBytes));
    row("Disk free", fmt.bytes(freeBytes));
  } catch {
    row("Temp dir", config.jobTempDir + " (not accessible)");
  }

  console.log("");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
