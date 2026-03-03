import mongoose from "mongoose";
import { connectDb } from "../db";
import { Job } from "../models/Job";
import { fmt, heading } from "./fmt";

function row(label: string, value: string | number) {
  console.log(`  ${String(label).padEnd(30)} ${value}`);
}

async function main() {
  await connectDb();

  // --- Job Status Breakdown ---
  heading("Job Status Breakdown");
  const statusCounts = await Job.aggregate([
    { $group: { _id: "$status", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  const statusMap = new Map(statusCounts.map((s) => [s._id, s.count]));
  const totalJobs = statusCounts.reduce((sum, s) => sum + s.count, 0);
  row("Total jobs created", fmt.num(totalJobs));
  const statusOrder = ["pending", "processing", "compressing", "compressed", "uploading", "completed", "failed", "cancelled"];
  for (const s of statusOrder) {
    const count = statusMap.get(s) || 0;
    if (count > 0) {
      const color = s === "failed" ? "\x1b[31m" : s === "completed" ? "\x1b[32m" : s === "cancelled" ? "\x1b[33m" : "\x1b[0m";
      row(`  ${s}`, `${color}${fmt.num(count)}\x1b[0m`);
    }
  }

  // --- Downloads ---
  heading("Downloads");
  const downloadAgg = await Job.aggregate([
    { $group: { _id: null, totalDownloads: { $sum: "$downloadCount" } } },
  ]);
  const totalDownloads = downloadAgg[0]?.totalDownloads ?? 0;
  row("Total downloads (all time)", fmt.num(totalDownloads));

  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [downloaded7d, downloaded30d, completed7d, completed30d] = await Promise.all([
    Job.countDocuments({ lastDownloadedAt: { $gte: d7 } }),
    Job.countDocuments({ lastDownloadedAt: { $gte: d30 } }),
    Job.countDocuments({ status: "completed", completedAt: { $gte: d7 } }),
    Job.countDocuments({ status: "completed", completedAt: { $gte: d30 } }),
  ]);
  row("Jobs downloaded (7d)", fmt.num(downloaded7d));
  row("Jobs downloaded (30d)", fmt.num(downloaded30d));
  row("Jobs completed (7d)", fmt.num(completed7d));
  row("Jobs completed (30d)", fmt.num(completed30d));

  // --- Duration Stats ---
  heading("Job Duration (completed jobs)");
  const durationAgg = await Job.aggregate([
    { $match: { status: "completed", startedAt: { $ne: null }, completedAt: { $ne: null } } },
    {
      $project: {
        durationSec: { $divide: [{ $subtract: ["$completedAt", "$startedAt"] }, 1000] },
      },
    },
    {
      $group: {
        _id: null,
        avg: { $avg: "$durationSec" },
        min: { $min: "$durationSec" },
        max: { $max: "$durationSec" },
        count: { $sum: 1 },
      },
    },
  ]);

  if (durationAgg.length > 0) {
    const d = durationAgg[0];
    row("Jobs with duration data", fmt.num(d.count));
    row("Average duration", fmt.duration(d.avg));
    row("Fastest", fmt.duration(d.min));
    row("Slowest", fmt.duration(d.max));
  } else {
    row("(no completed jobs with timing data)", "");
  }

  // --- Most Popular Characters ---
  heading("Most Popular Characters (in filters)");
  const charAgg = await Job.aggregate([
    { $match: { "filter.p1CharacterId": { $ne: null } } },
    { $group: { _id: "$filter.p1CharacterId", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]);
  if (charAgg.length > 0) {
    for (const c of charAgg) {
      row(`  Character ${c._id}`, fmt.num(c.count) + " jobs");
    }
  } else {
    row("(no character filters used)", "");
  }

  // --- Most Popular Stages ---
  heading("Most Popular Stages (in filters)");
  const stageAgg = await Job.aggregate([
    { $match: { "filter.stageId": { $ne: null } } },
    { $group: { _id: "$filter.stageId", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]);
  if (stageAgg.length > 0) {
    for (const s of stageAgg) {
      row(`  Stage ${s._id}`, fmt.num(s.count) + " jobs");
    }
  } else {
    row("(no stage filters used)", "");
  }

  // --- Most Popular Connect Codes ---
  heading("Most Popular Connect Codes (in filters)");
  const codeAgg = await Job.aggregate([
    { $match: { "filter.p1ConnectCode": { $ne: null } } },
    { $group: { _id: "$filter.p1ConnectCode", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]);
  if (codeAgg.length > 0) {
    for (const c of codeAgg) {
      row(`  ${c._id}`, fmt.num(c.count) + " jobs");
    }
  } else {
    row("(no connect code filters used)", "");
  }

  // --- Top 10 Most Downloaded Bundles ---
  heading("Top 10 Most Downloaded Bundles");
  const topDownloads = await Job.find({ downloadCount: { $gt: 0 } })
    .sort({ downloadCount: -1 })
    .limit(10)
    .select("downloadCount bundleSize replayCount filter completedAt")
    .lean();

  if (topDownloads.length > 0) {
    for (const j of topDownloads) {
      const id = j._id.toString().slice(-6);
      const size = j.bundleSize ? fmt.bytes(j.bundleSize) : "?";
      const filterParts: string[] = [];
      if (j.filter.p1ConnectCode) filterParts.push(j.filter.p1ConnectCode);
      if (j.filter.p1CharacterId) filterParts.push(`char=${j.filter.p1CharacterId}`);
      if (j.filter.stageId) filterParts.push(`stage=${j.filter.stageId}`);
      const filterStr = filterParts.length > 0 ? filterParts.join(", ") : "no filter";
      console.log(`  ...${id}  ${fmt.num(j.downloadCount)} downloads  ${size}  ${j.replayCount} replays  [${filterStr}]`);
    }
  } else {
    console.log("  (no downloads yet)");
  }

  // --- Zero-Download Waste ---
  heading("Zero-Download Jobs (waste ratio)");
  const completedCount = statusMap.get("completed") || 0;
  const zeroDownloads = await Job.countDocuments({ status: "completed", downloadCount: 0 });
  row("Completed jobs", fmt.num(completedCount));
  row("Never downloaded", fmt.num(zeroDownloads));
  if (completedCount > 0) {
    row("Waste ratio", ((zeroDownloads / completedCount) * 100).toFixed(1) + "%");
  }

  // --- R2 Storage ---
  heading("R2 Storage");
  const r2Active = await Job.aggregate([
    { $match: { status: "completed", r2Key: { $ne: null } } },
    { $group: { _id: null, count: { $sum: 1 }, totalSize: { $sum: "$bundleSize" } } },
  ]);
  const activeCount = r2Active[0]?.count ?? 0;
  const activeSize = r2Active[0]?.totalSize ?? 0;
  row("Active R2 objects", fmt.num(activeCount));
  row("Active R2 size", fmt.bytes(activeSize));

  const r2Cleaned = await Job.aggregate([
    { $match: { status: "completed", r2Key: null, bundleSize: { $ne: null } } },
    { $group: { _id: null, count: { $sum: 1 }, totalSize: { $sum: "$bundleSize" } } },
  ]);
  const cleanedCount = r2Cleaned[0]?.count ?? 0;
  const cleanedSize = r2Cleaned[0]?.totalSize ?? 0;
  row("Cleaned R2 objects", fmt.num(cleanedCount));
  row("Freed storage", fmt.bytes(cleanedSize));

  console.log("");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
