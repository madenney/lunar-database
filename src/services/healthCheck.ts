import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import mongoose from "mongoose";
import { config } from "../config";
import { getTempDiskUsage } from "./bundler";
import { pingStorage } from "./storage";
import { isCompressorRunning, getCompressorJobId } from "../workers/compressWorker";
import { isUploaderRunning, getUploaderJobId } from "../workers/uploadWorker";

/**
 * On-demand, end-to-end health check for the admin "DB online & healthy" pill.
 *
 * Unlike the passive /status endpoint (which only proves the API process and
 * Mongo are up), this actively exercises every piece a download job depends on:
 * the database, the mounted replay drive, the compressor binary, object storage,
 * disk headroom, and the worker processes. The pill only goes green when ALL of
 * these pass — so "healthy" actually means jobs can run end to end.
 */

export interface HealthCheck {
  /** Stable id so the frontend can show the list before results arrive. */
  key: string;
  /** Human-readable name shown in the panel. */
  name: string;
  /** True when this piece is working. */
  ok: boolean;
  /** Short explanation (timing, path, free space, or the failure reason). */
  detail: string;
  /** When false, a failure is a warning (e.g. a deliberately stopped worker)
   *  rather than a hard outage — still surfaced, but doesn't read as "broken". */
  critical: boolean;
}

export interface HealthReport {
  /** True only when every critical check passed. */
  healthy: boolean;
  checks: HealthCheck[];
  checkedAt: string;
}

/** The fixed order/list of checks, so the frontend can render the checklist
 *  (as "running…") before the results come back. */
export const HEALTH_CHECK_KEYS = [
  { key: "database", name: "Database connection" },
  { key: "replay-drive", name: "Replay storage drive" },
  { key: "compressor-bin", name: "Compression tool (slpz)" },
  { key: "object-storage", name: "Object storage (B2)" },
  { key: "disk-space", name: "Free disk space" },
  { key: "temp-writable", name: "Temp directory writable" },
  { key: "workers", name: "Worker processes" },
] as const;

function formatBytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(2)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${n} B`;
}

/** Reject if a check hangs (a wedged NFS mount or S3 call can block forever). */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function checkDatabase(): Promise<HealthCheck> {
  const base = { key: "database", name: "Database connection", critical: true };
  try {
    if (mongoose.connection.readyState !== 1) {
      return { ...base, ok: false, detail: "Mongoose is not connected" };
    }
    const start = Date.now();
    await withTimeout(mongoose.connection.db!.command({ ping: 1 }), 5000);
    return { ...base, ok: true, detail: `responded in ${Date.now() - start}ms` };
  } catch (err) {
    return { ...base, ok: false, detail: (err as Error).message };
  }
}

async function checkReplayDrive(): Promise<HealthCheck> {
  const base = { key: "replay-drive", name: "Replay storage drive", critical: true };
  try {
    const root = path.resolve(config.slpRootDir);
    if (!fs.existsSync(root)) {
      return { ...base, ok: false, detail: `${root} not found — drive is not mounted` };
    }
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) {
      return { ...base, ok: false, detail: `${root} is not a directory` };
    }
    // A failed/absent mount typically leaves the mount point as an empty dir.
    const entries = await withTimeout(fsp.readdir(root), 5000);
    if (entries.length === 0) {
      return { ...base, ok: false, detail: `${root} is empty — drive likely not mounted` };
    }
    return { ...base, ok: true, detail: `mounted at ${root} (${entries.length} entries)` };
  } catch (err) {
    return { ...base, ok: false, detail: (err as Error).message };
  }
}

async function checkCompressorBinary(): Promise<HealthCheck> {
  const base = { key: "compressor-bin", name: "Compression tool (slpz)", critical: true };
  try {
    if (!fs.existsSync(config.slpzBinary)) {
      return { ...base, ok: false, detail: `slpz not found at ${config.slpzBinary}` };
    }
    fs.accessSync(config.slpzBinary, fs.constants.X_OK);
    return { ...base, ok: true, detail: `found at ${config.slpzBinary}` };
  } catch {
    return { ...base, ok: false, detail: `slpz at ${config.slpzBinary} is not executable` };
  }
}

async function checkObjectStorage(): Promise<HealthCheck> {
  const base = { key: "object-storage", name: "Object storage (B2)", critical: true };
  try {
    await withTimeout(pingStorage(), 8000);
    return { ...base, ok: true, detail: `bucket "${config.s3BucketName}" reachable` };
  } catch (err) {
    return { ...base, ok: false, detail: (err as Error).message };
  }
}

async function checkDiskSpace(): Promise<HealthCheck> {
  const base = { key: "disk-space", name: "Free disk space", critical: true };
  try {
    const disk = await withTimeout(getTempDiskUsage(), 8000);
    const freeMb = Math.round(disk.freeBytes / (1024 * 1024));
    const ok = freeMb >= config.minFreeDiskMb;
    const detail = `${formatBytes(disk.freeBytes)} free (minimum ${config.minFreeDiskMb} MB)`;
    return { ...base, ok, detail };
  } catch (err) {
    return { ...base, ok: false, detail: (err as Error).message };
  }
}

async function checkTempWritable(): Promise<HealthCheck> {
  const base = { key: "temp-writable", name: "Temp directory writable", critical: true };
  try {
    const dir = config.jobTempDir;
    await fsp.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.healthcheck-${process.pid}`);
    await fsp.writeFile(probe, "ok");
    await fsp.unlink(probe);
    return { ...base, ok: true, detail: `${dir} is writable` };
  } catch (err) {
    return { ...base, ok: false, detail: (err as Error).message };
  }
}

async function checkWorkers(): Promise<HealthCheck> {
  // A stopped worker is a warning, not an outage — they can be paused on purpose.
  const base = { key: "workers", name: "Worker processes", critical: false };
  const compressor = isCompressorRunning();
  const uploader = isUploaderRunning();
  const parts = [
    `compressor ${compressor ? "running" : "stopped"}${compressor && getCompressorJobId() ? ` (job ${getCompressorJobId()})` : ""}`,
    `uploader ${uploader ? "running" : "stopped"}${uploader && getUploaderJobId() ? ` (job ${getUploaderJobId()})` : ""}`,
  ];
  return { ...base, ok: compressor && uploader, detail: parts.join(", ") };
}

export async function runHealthChecks(): Promise<HealthReport> {
  // Run in parallel — each has its own timeout so one wedged check can't hang
  // the whole report. Order the results to match HEALTH_CHECK_KEYS.
  const checks = await Promise.all([
    checkDatabase(),
    checkReplayDrive(),
    checkCompressorBinary(),
    checkObjectStorage(),
    checkDiskSpace(),
    checkTempWritable(),
    checkWorkers(),
  ]);

  const healthy = checks.every((c) => c.ok || !c.critical);
  return { healthy, checks, checkedAt: new Date().toISOString() };
}

// --- Cached, stale-while-revalidate access for frequent pollers ----------------
//
// The full report is expensive — a B2 HeadBucket plus several filesystem probes —
// so a status dashboard polling every ~30s must NOT trigger it on every hit.
// getCachedHealth() serves the last completed report instantly and, only when it
// is older than the TTL, kicks off ONE background refresh. Net effect: the deep
// work runs at most once per TTL, and only while something is actually polling
// (no work when nobody's watching). This mirrors Spring Actuator's health-cache
// TTL and the stale-while-revalidate (RFC 5861) caching semantics.

let cachedReport: HealthReport | null = null;
let cachedAt = 0;
let refreshing = false;

export interface CachedHealth {
  /** Most recent completed report, or null if none has finished yet. */
  report: HealthReport | null;
  /** Age of `report` in ms (Infinity if there is no report yet). */
  ageMs: number;
}

export function getCachedHealth(ttlMs = 120_000): CachedHealth {
  const ageMs = cachedReport ? Date.now() - cachedAt : Infinity;
  if (!refreshing && ageMs > ttlMs) {
    refreshing = true;
    runHealthChecks()
      .then((report) => {
        cachedReport = report;
        cachedAt = Date.now();
      })
      .catch(() => {
        // Keep serving the stale report on error rather than dropping to null.
      })
      .finally(() => {
        refreshing = false;
      });
  }
  return { report: cachedReport, ageMs };
}
