import mongoose from "mongoose";
import { config } from "../config";
import { sendAlertEmail } from "./mailer";
import { getTempDiskUsage } from "./bundler";
import { isCompressorRunning } from "../workers/compressWorker";
import { isUploaderRunning } from "../workers/uploadWorker";
import { Job } from "../models/Job";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DISK_WARNING_MB = config.minFreeDiskMb * 2; // warn at 2x the hard limit
const STUCK_JOB_MINUTES = config.jobTimeoutMinutes;

interface HealthState {
  mongoDown: boolean;
  diskLow: boolean;
  stuckJob: string | null;
  workersCrashed: boolean;
  lastFailedJobId: string | null;
}

const previous: HealthState = {
  mongoDown: false,
  diskLow: false,
  stuckJob: null,
  workersCrashed: false,
  lastFailedJobId: null,
};

let intervalHandle: ReturnType<typeof setInterval> | null = null;

async function checkHealth(): Promise<void> {
  const alerts: string[] = [];
  const recoveries: string[] = [];

  // 1. MongoDB connection
  const mongoOk = mongoose.connection.readyState === 1;
  if (!mongoOk && !previous.mongoDown) {
    alerts.push("MongoDB connection is DOWN");
  } else if (mongoOk && previous.mongoDown) {
    recoveries.push("MongoDB connection recovered");
  }
  previous.mongoDown = !mongoOk;

  // Skip remaining checks if DB is down
  if (!mongoOk) {
    if (alerts.length > 0) await sendAlert(alerts, recoveries);
    return;
  }

  // 2. Disk space
  try {
    const disk = await getTempDiskUsage();
    const freeMb = Math.round(disk.freeBytes / (1024 * 1024));
    const diskLow = freeMb < DISK_WARNING_MB;

    if (diskLow && !previous.diskLow) {
      alerts.push(`Disk space low: ${freeMb}MB free (warning threshold: ${DISK_WARNING_MB}MB)`);
    } else if (!diskLow && previous.diskLow) {
      recoveries.push(`Disk space recovered: ${freeMb}MB free`);
    }
    previous.diskLow = diskLow;
  } catch (err) {
    // Can't check disk — not critical enough to alert
  }

  // 3. Stuck jobs (processing for longer than timeout)
  try {
    const cutoff = new Date(Date.now() - STUCK_JOB_MINUTES * 60 * 1000);
    const stuckJob = await Job.findOne({
      status: { $in: ["processing", "compressing", "uploading"] },
      startedAt: { $lt: cutoff },
    }).select("_id status startedAt").lean();

    const stuckId = stuckJob?._id?.toString() || null;
    if (stuckId && stuckId !== previous.stuckJob) {
      alerts.push(`Job ${stuckId} appears stuck (status: ${stuckJob!.status}, started: ${stuckJob!.startedAt})`);
    } else if (!stuckId && previous.stuckJob) {
      recoveries.push("Stuck job resolved");
    }
    previous.stuckJob = stuckId;
  } catch {}

  // 4. Recent job failures
  try {
    const recentFailed = await Job.findOne({ status: "failed" })
      .sort({ updatedAt: -1 })
      .select("_id error updatedAt")
      .lean();

    const failedId = recentFailed?._id?.toString() || null;
    if (failedId && failedId !== previous.lastFailedJobId) {
      alerts.push(`Job ${failedId} failed: ${recentFailed!.error || "unknown error"}`);
    }
    previous.lastFailedJobId = failedId;
  } catch {}

  // 5. Workers running check (only alert if both are down)
  const bothDown = !isCompressorRunning() && !isUploaderRunning();
  if (bothDown && !previous.workersCrashed) {
    // Check if there are pending jobs — only alert if there's work to do
    const pendingCount = await Job.countDocuments({ status: "pending" }).catch(() => 0);
    if (pendingCount > 0) {
      alerts.push(`Both workers are stopped but ${pendingCount} jobs are pending`);
    }
  } else if (!bothDown && previous.workersCrashed) {
    recoveries.push("Workers recovered");
  }
  previous.workersCrashed = bothDown;

  if (alerts.length > 0 || recoveries.length > 0) {
    await sendAlert(alerts, recoveries);
  }
}

async function sendAlert(alerts: string[], recoveries: string[]): Promise<void> {
  const lines: string[] = [];

  if (alerts.length > 0) {
    lines.push("PROBLEMS:", ...alerts.map((a) => `  - ${a}`), "");
  }
  if (recoveries.length > 0) {
    lines.push("RECOVERED:", ...recoveries.map((r) => `  + ${r}`), "");
  }

  lines.push(`Timestamp: ${new Date().toISOString()}`);
  lines.push(`Server uptime: ${Math.round(process.uptime() / 60)} minutes`);

  const subject = alerts.length > 0
    ? alerts[0]
    : `Recovered: ${recoveries[0]}`;

  try {
    await sendAlertEmail(subject, lines.join("\n"));
    console.log(`[HEALTH] Alert sent: ${subject}`);
  } catch (err) {
    console.error("[HEALTH] Failed to send alert email:", (err as Error).message);
  }
}

export function startHealthMonitor(): void {
  if (intervalHandle) return;
  console.log(`[HEALTH] Monitor started (checking every ${CHECK_INTERVAL_MS / 1000}s)`);
  // Run first check after a short delay to let everything initialize
  setTimeout(() => checkHealth().catch(console.error), 30_000);
  intervalHandle = setInterval(() => checkHealth().catch(console.error), CHECK_INTERVAL_MS);
}

export function stopHealthMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[HEALTH] Monitor stopped");
  }
}
