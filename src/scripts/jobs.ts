import mongoose from "mongoose";
import { connectDb } from "../db";
import { Job, JobStatus } from "../models/Job";

const fmt = {
  num: (n: number) => n.toLocaleString(),
  bytes: (b: number) => {
    if (b >= 1e12) return (b / 1e12).toFixed(1) + " TB";
    if (b >= 1e9) return (b / 1e9).toFixed(1) + " GB";
    if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
    if (b >= 1e3) return (b / 1e3).toFixed(1) + " KB";
    return b + " B";
  },
  date: (d: Date | null) => {
    if (!d) return "-";
    return d.toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    });
  },
  duration: (start: Date | null, end: Date | null) => {
    if (!start) return "-";
    const ms = (end || new Date()).getTime() - start.getTime();
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  },
};

const VALID_STATUSES: JobStatus[] = [
  "pending", "processing", "compressing", "compressed", "uploading", "completed", "failed", "cancelled",
];

const USAGE = `Usage: npm run jobs [status] [--limit N]

  status:   Filter by job status (${VALID_STATUSES.join(", ")})
            Use "active" for processing/compressing/compressed/uploading
            Use "queue" for pending jobs
            Default: shows all non-terminal jobs

  --limit N  Number of jobs to show (default: 20)

Examples:
  npm run jobs              # Active + pending jobs
  npm run jobs failed       # Recent failed jobs
  npm run jobs completed    # Recent completed jobs
  npm run jobs -- --limit 50   # Show more results`;

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  let statusFilter: JobStatus[] | undefined;
  let limit = 20;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "active") {
      statusFilter = ["processing", "compressing", "compressed", "uploading"];
    } else if (args[i] === "queue") {
      statusFilter = ["pending"];
    } else if (VALID_STATUSES.includes(args[i] as JobStatus)) {
      statusFilter = [args[i] as JobStatus];
    }
  }

  // Default: non-terminal jobs
  if (!statusFilter) {
    statusFilter = ["pending", "processing", "compressing", "compressed", "uploading"];
  }

  await connectDb();

  const query: any = { status: { $in: statusFilter } };
  const sort: any = statusFilter.includes("completed") || statusFilter.includes("failed") || statusFilter.includes("cancelled")
    ? { updatedAt: -1 }
    : { priority: 1, createdAt: 1 };

  const jobs = await Job.find(query).sort(sort).limit(limit).lean();
  const total = await Job.countDocuments(query);

  if (jobs.length === 0) {
    console.log(`No jobs with status: ${statusFilter.join(", ")}`);
    await mongoose.disconnect();
    return;
  }

  console.log(`\nShowing ${jobs.length} of ${fmt.num(total)} jobs (${statusFilter.join(", ")}):\n`);

  // Table header
  const header = [
    "ID".padEnd(8),
    "Status".padEnd(12),
    "Replays".padStart(8),
    "Size".padStart(10),
    "Progress".padEnd(16),
    "Duration".padStart(10),
    "Created".padEnd(16),
    "Filter",
  ].join("  ");
  console.log(`  ${header}`);
  console.log(`  ${"=".repeat(header.length)}`);

  for (const j of jobs) {
    const id = j._id.toString().slice(-8);

    // Status with color
    const statusColors: Record<string, string> = {
      pending: "\x1b[33m", processing: "\x1b[36m", compressing: "\x1b[36m",
      compressed: "\x1b[36m", uploading: "\x1b[36m", completed: "\x1b[32m",
      failed: "\x1b[31m", cancelled: "\x1b[90m",
    };
    const color = statusColors[j.status] || "";
    const status = `${color}${j.status.padEnd(12)}\x1b[0m`;

    const replays = j.replayCount ? fmt.num(j.replayCount).padStart(8) : "-".padStart(8);
    const size = j.bundleSize ? fmt.bytes(j.bundleSize).padStart(10)
      : j.estimatedSize ? ("~" + fmt.bytes(j.estimatedSize)).padStart(10)
      : "-".padStart(10);

    let progress = "-".padEnd(16);
    if (j.progress) {
      progress = `${j.progress.step} ${j.progress.filesProcessed}/${j.progress.filesTotal}`.padEnd(16);
    } else if (j.status === "failed" && j.error) {
      progress = j.error.slice(0, 16).padEnd(16);
    }

    const duration = fmt.duration(j.startedAt, j.completedAt).padStart(10);
    const created = fmt.date(j.createdAt).padEnd(16);

    // Build filter summary
    const filterParts: string[] = [];
    if (j.filter.p1ConnectCode) filterParts.push(`p1=${j.filter.p1ConnectCode}`);
    if (j.filter.p2ConnectCode) filterParts.push(`p2=${j.filter.p2ConnectCode}`);
    if (j.filter.p1CharacterId) filterParts.push(`p1char=${j.filter.p1CharacterId}`);
    if (j.filter.p2CharacterId) filterParts.push(`p2char=${j.filter.p2CharacterId}`);
    if (j.filter.stageId) filterParts.push(`stage=${j.filter.stageId}`);
    if (j.filter.maxFiles) filterParts.push(`max=${j.filter.maxFiles}`);
    const filterStr = filterParts.join(" ") || "-";

    console.log(`  ${id}  ${status}  ${replays}  ${size}  ${progress}  ${duration}  ${created}  ${filterStr}`);
  }

  if (total > jobs.length) {
    console.log(`\n  ... ${total - jobs.length} more (use --limit to see more)`);
  }

  console.log("");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
