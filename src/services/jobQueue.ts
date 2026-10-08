/**
 * Download-queue policy and forecasting.
 *
 *  - filterKey: identical requests share one job (reuse instead of rebuilding).
 *  - lanes: bundles up to config.fastLaneMaxMb are "fast"; the fast worker pair
 *    only takes those, the main pair takes anything in order, so a 70 GB job
 *    can't hold up a 50 MB one.
 *  - throughput: measured from recent jobs, so wait estimates track reality.
 *  - simulateQueue: when each waiting job should start and finish.
 *  - queue state: paused manually (admin) or automatically (archive drive
 *    offline, storage cap hit); workers don't claim jobs while paused and
 *    users are told why.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import mongoose from "mongoose";
import { Job, type IJob } from "../models/Job";
import { ACTIVE_JOB_STATUSES } from "../models/jobStatus";
import { config } from "../config";
import { sendAlertEmail } from "./mailer";

const MB = 1024 * 1024;
/** Short-lived caches keep the queue cheap under launch traffic; tests read fresh data. */
const CACHING = process.env.NODE_ENV !== "test";

// ---------------------------------------------------------------- reuse

/** Filter fields that change which replays a bundle holds. */
const KEY_FIELDS = [
  "p1ConnectCode", "p1CharacterId", "p1DisplayName", "p1Rank",
  "p2ConnectCode", "p2CharacterId", "p2DisplayName", "p2Rank",
  "stageId", "startDate", "endDate", "source", "tournament", "maxFiles", "maxSizeMb", "sort", "clipSearch",
] as const;

/** An id list's part of the key: count + hash of the sorted ids (a key stays short at 10,000 ids). */
function idsKey(ids: unknown): string | null {
  if (!Array.isArray(ids) || !ids.length) return null;
  const sorted = [...ids].map(String).sort();
  return `${sorted.length}:${crypto.createHash("sha1").update(sorted.join(",")).digest("hex")}`;
}

/**
 * Canonical key of a job filter: same key = same bundle. List values are
 * order-insensitive; sort only matters when a limit picks the first N.
 */
export function filterKey(filter: Record<string, unknown>): string {
  const limited = filter.maxFiles != null || filter.maxSizeMb != null;
  const parts: string[] = [];
  for (const k of KEY_FIELDS) {
    let v = filter[k];
    if (v == null || v === "") continue;
    if (k === "sort" && !limited) continue;
    if (typeof v === "string" && k !== "startDate" && k !== "endDate" && k !== "sort" && k !== "clipSearch") {
      v = v.split(",").map((s) => s.trim()).filter(Boolean).sort().join(",");
    }
    parts.push(`${k}=${v}`);
  }
  const ids = idsKey(filter.replayIds);
  if (ids) parts.push(`replayIds=${ids}`);
  return parts.join("&");
}

/** A job (active, or finished and still in storage) another request can share. */
export async function findReusableJob(key: string) {
  if (!key) return null;
  const since = new Date(Date.now() - config.jobReuseHours * 3600 * 1000);
  return Job.findOne({
    filterKey: key,
    isFullDb: { $ne: true },
    $or: [
      { status: { $in: ACTIVE_JOB_STATUSES } },
      { status: "completed", r2Key: { $ne: null }, completedAt: { $gte: since } },
    ],
  })
    .sort({ createdAt: -1 })
    .select("_id status createdBy")
    .lean();
}

// ---------------------------------------------------------------- sizes and lanes

export type Lane = "fast" | "main";

/** Bundle bytes a job will produce (actual once bundled, else the estimate). */
export function bundleBytes(j: Pick<IJob, "bundleSize" | "estimatedSize" | "replayCount">): number {
  if (j.bundleSize) return j.bundleSize;
  return Math.round((j.estimatedSize ?? 0) / 8) + (j.replayCount ?? 0) * 128;
}

export function laneFor(bytes: number): Lane {
  return bytes <= config.fastLaneMaxMb * MB ? "fast" : "main";
}

/** Bytes a job still has to push through the pipeline. */
function remainingBytes(j: IJobLike): number {
  const total = bundleBytes(j);
  const p = j.progress;
  if (!p) return j.status === "bundled" ? total * 0.5 : total;
  if (p.step === "uploading" && p.bytesTotal) return Math.max(0, (p.bytesTotal - (p.bytesUploaded ?? 0)) * 0.5);
  // Streaming bundles build and upload in one pass: progress is linear in files.
  if (p.step === "bundling" && p.bytesUploaded != null && p.filesTotal) return total * (1 - p.filesProcessed / p.filesTotal);
  if (p.filesTotal) return total * (1 - 0.5 * (p.filesProcessed / p.filesTotal)); // two-phase bundling ~ first half
  return total;
}

// ---------------------------------------------------------------- throughput

let rateCache: { at: number; bps: number } | null = null;

/** Forecasts plan with this share of the measured speed, so most people are ready early, not late. */
export const FORECAST_MARGIN = 0.8;

/**
 * Bytes per second the whole pipeline moved: the bytes of these finished jobs
 * over the time at least one of them was running (overlaps counted once). Null
 * when there's too little to go on (< 10 busy minutes or < 200 MB).
 */
export function pipelineRate(jobs: { start: number; end: number; bytes: number }[]): number | null {
  const spans = jobs.filter((j) => j.end > j.start && j.bytes > 0).sort((a, b) => a.start - b.start);
  let busyMs = 0;
  let bytes = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const j of spans) {
    bytes += j.bytes;
    if (j.start > curEnd) {
      if (curEnd > curStart) busyMs += curEnd - curStart;
      curStart = j.start;
      curEnd = j.end;
    } else curEnd = Math.max(curEnd, j.end);
  }
  if (curEnd > curStart) busyMs += curEnd - curStart;
  if (busyMs < 10 * 60 * 1000 || bytes < 200 * MB) return null;
  return bytes / (busyMs / 1000);
}

/**
 * Pipeline throughput in bundle bytes/second, for the forecasts. Measured from
 * the last 6 hours of finished jobs (pipelineRate): bundles share a paced uplink
 * budget with replay views, so the real rate depends on how busy the site is.
 * Falls back to the median single-job rate of recent big jobs, then to the
 * configured speed; never above the uplink budget. Recomputed every 10 minutes.
 * (Before 2026-10-08 it used single-job rates from unpaced uploads and promised
 * waits 2-4x too short.)
 */
export async function throughputBps(): Promise<number> {
  if (CACHING && rateCache && Date.now() - rateCache.at < 10 * 60 * 1000) return rateCache.bps;
  let bps = config.estimateUploadSpeedMbps * 125_000;
  try {
    const recent = await Job.find({
      status: "completed",
      isFullDb: { $ne: true },
      bundleSize: { $gt: 0 },
      startedAt: { $ne: null },
      completedAt: { $gte: new Date(Date.now() - 6 * 3600 * 1000) },
    })
      .select("bundleSize startedAt completedAt")
      .limit(1000)
      .lean();
    const measured = pipelineRate(recent.map((j) => ({ start: j.startedAt!.getTime(), end: j.completedAt!.getTime(), bytes: j.bundleSize ?? 0 })));
    if (measured) bps = measured;
    else {
      const big = await Job.find({
        status: "completed",
        isFullDb: { $ne: true },
        bundleSize: { $gt: 50 * MB },
        startedAt: { $ne: null },
        completedAt: { $gte: new Date(Date.now() - 30 * 86400 * 1000) },
      })
        .sort({ completedAt: -1 })
        .limit(25)
        .select("bundleSize startedAt completedAt")
        .lean();
      const rates = big
        .map((j) => (j.bundleSize ?? 0) / Math.max(1, (j.completedAt!.getTime() - j.startedAt!.getTime()) / 1000))
        .filter((r) => r > 0)
        .sort((a, b) => a - b);
      if (rates.length >= 3) bps = rates[Math.floor(rates.length / 2)];
    }
  } catch {
    /* keep the fallback */
  }
  bps = Math.min(bps, config.uplinkBytesPerSec) * FORECAST_MARGIN;
  rateCache = { at: Date.now(), bps };
  return bps;
}

export function _resetThroughputCache() {
  rateCache = null;
}

// ---------------------------------------------------------------- simulation

export type IJobLike = Pick<IJob, "status" | "bundleSize" | "estimatedSize" | "replayCount" | "progress" | "createdAt" | "priority"> & {
  _id: unknown;
  lane?: Lane | null;
};

export interface Forecast {
  /** Seconds until the job starts (0 when already running). */
  startSec: number;
  /** Seconds until its bundle is ready. */
  readySec: number;
  /** Jobs that start before this one. */
  ahead: number;
}

/**
 * Index of the fast-lane job the fast worker takes next: the smallest (then the
 * oldest), so a 10-game bundle isn't stuck behind 200 MB ones (download-rush test:
 * small bundles waited up to 16 min first-come-first-served). The lane is capped
 * at fastLaneMaxMb, so nothing in it waits long; the main worker still takes the
 * oldest job of any size. compressWorker claims in the same order.
 */
function smallestFast(queue: IJobLike[]): number {
  let best = -1;
  for (let i = 0; i < queue.length; i++) {
    const j = queue[i];
    if ((j.lane ?? laneFor(bundleBytes(j))) !== "fast") continue;
    if (best < 0) { best = i; continue; }
    const b = queue[best];
    const byPriority = (j.priority ?? 0) - (b.priority ?? 0);
    if (byPriority < 0 || (byPriority === 0 && bundleBytes(j) < bundleBytes(b))) best = i;
  }
  return best;
}

/**
 * Forecast the queue. Two workers share one uplink (bytes/sec `bps`): the fast
 * worker takes only fast-lane jobs, the main worker takes whatever is next.
 * Running jobs keep their worker. Returns a forecast per job id.
 */
export function simulateQueue(running: IJobLike[], pending: IJobLike[], bps: number): Map<string, Forecast> {
  const out = new Map<string, Forecast>();
  type Slot = { id: string; left: number } | null;
  const slots: Record<Lane, Slot> = { fast: null, main: null };
  // Running jobs: the fast-lane ones are assumed on the fast worker unless it's taken.
  for (const j of running) {
    const lane: Lane = j.lane === "fast" && !slots.fast ? "fast" : !slots.main ? "main" : "fast";
    slots[lane] = { id: String(j._id), left: remainingBytes(j) };
    out.set(String(j._id), { startSec: 0, readySec: 0, ahead: 0 });
  }
  const queue = [...pending].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.createdAt.getTime() - b.createdAt.getTime());
  let t = 0;
  let started = 0;
  const take = (lane: Lane) => {
    const i = lane === "fast" ? smallestFast(queue) : 0;
    if (i < 0 || !queue.length) return;
    const [j] = queue.splice(i, 1);
    slots[lane] = { id: String(j._id), left: remainingBytes(j) };
    out.set(String(j._id), { startSec: t, readySec: 0, ahead: started++ });
  };
  for (let guard = 0; guard < 100_000; guard++) {
    if (!slots.fast) take("fast");
    if (!slots.main) take("main");
    const busy = (["fast", "main"] as Lane[]).filter((l) => slots[l]);
    if (!busy.length) break;
    const rate = bps / busy.length;
    const next = Math.min(...busy.map((l) => slots[l]!.left));
    t += next / rate;
    for (const l of busy) {
      const s = slots[l]!;
      s.left -= next;
      if (s.left <= 1) {
        const f = out.get(s.id)!;
        out.set(s.id, { ...f, readySec: Math.round(t) });
        slots[l] = null;
      }
    }
  }
  for (const [id, f] of out) out.set(id, { ...f, startSec: Math.round(f.startSec) });
  return out;
}

// ---------------------------------------------------------------- snapshot

const RUNNING = ["processing", "bundling", "bundled", "uploading"];

type Snapshot = {
  at: number;
  bps: number;
  running: any[];
  pending: any[];
  forecast: Map<string, Forecast>;
};
let snapCache: Snapshot | null = null;

/** Running + waiting jobs and their forecasts; cached for a few seconds (hot at launch). */
export async function queueSnapshot(maxAgeMs = 5000): Promise<Snapshot> {
  if (CACHING && snapCache && Date.now() - snapCache.at < maxAgeMs) return snapCache;
  const fields = "status filter replayCount estimatedSize bundleSize progress createdAt priority lane createdBy followers startedAt";
  const [running, pending, bps] = await Promise.all([
    Job.find({ status: { $in: RUNNING } }).select(fields).lean(),
    Job.find({ status: "pending" }).sort({ priority: 1, createdAt: 1 }).limit(2000).select(fields).lean(),
    throughputBps(),
  ]);
  snapCache = { at: Date.now(), bps, running, pending, forecast: simulateQueue(running as any, pending as any, bps) };
  return snapCache;
}

export function _resetSnapshotCache() {
  snapCache = null;
}

/** Forecast for a job that would be created now with this bundle size. */
export async function forecastNewJob(bytes: number): Promise<Forecast & { lane: Lane; waiting: number }> {
  const snap = await queueSnapshot();
  const lane = laneFor(bytes);
  const probe = { _id: "__new__", status: "pending", bundleSize: bytes, estimatedSize: null, replayCount: 0, progress: null, createdAt: new Date(), priority: 0, lane } as any;
  const f = simulateQueue(snap.running as any, [...(snap.pending as any), probe], snap.bps).get("__new__")!;
  return { ...f, lane, waiting: snap.pending.length };
}

/** Total seconds of work in the queue (to say how busy it is). */
export async function queueWorkSec(): Promise<number> {
  const snap = await queueSnapshot();
  let max = 0;
  for (const f of snap.forecast.values()) max = Math.max(max, f.readySec);
  return max;
}

// ---------------------------------------------------------------- pause state

export type PauseReason = "manual" | "storage_offline" | "storage_cap";
export interface QueueState {
  paused: boolean;
  reason: PauseReason | null;
  message: string | null;
  since: Date | null;
}

const STATE_ID = "downloadQueue";
let stateCache: { at: number; state: QueueState } | null = null;
const settings = () => mongoose.connection.collection<{ _id: string } & QueueState>("settings");

export async function getQueueState(maxAgeMs = 5000): Promise<QueueState> {
  if (CACHING && stateCache && Date.now() - stateCache.at < maxAgeMs) return stateCache.state;
  const doc = await settings().findOne({ _id: STATE_ID });
  const state: QueueState = { paused: !!doc?.paused, reason: doc?.reason ?? null, message: doc?.message ?? null, since: doc?.since ?? null };
  stateCache = { at: Date.now(), state };
  return state;
}

export async function setQueueState(paused: boolean, reason: PauseReason | null, message: string | null = null) {
  const state: QueueState = { paused, reason: paused ? reason : null, message: paused ? message : null, since: paused ? new Date() : null };
  await settings().updateOne({ _id: STATE_ID }, { $set: state }, { upsert: true });
  stateCache = { at: Date.now(), state };
  return state;
}

/** User-facing reason for a pause. */
export function pauseMessage(s: QueueState): string | null {
  if (!s.paused) return null;
  if (s.message) return s.message;
  if (s.reason === "storage_offline") return "Downloads are paused while the replay archive comes back online. Your place in line is kept.";
  if (s.reason === "storage_cap") return "Downloads are paused while we raise a storage limit. Your place in line is kept.";
  return "Downloads are paused for maintenance. Your place in line is kept.";
}

async function autoPause(reason: Exclude<PauseReason, "manual">, detail: string) {
  const s = await getQueueState(0);
  if (s.paused) return; // never override a manual pause or an earlier reason
  await setQueueState(true, reason);
  console.error(`Download queue paused (${reason}): ${detail}`);
  sendAlertEmail(`Download queue paused: ${reason}`, `${detail}\n\nJobs stay queued. Resume from the admin page once fixed${reason === "storage_offline" ? " (resumes automatically when the archive is back)" : ""}.`).catch(() => {});
}

/** Pause uploads after the storage provider refused one for a cap. */
export function pauseForStorageCap(detail: string) {
  return autoPause("storage_cap", detail);
}

/**
 * May a worker claim a job now? Pauses the queue when the replay archive is
 * missing (drive not mounted) instead of failing every job, and resumes it on
 * its own once the archive is back.
 */
export async function queueGate(): Promise<boolean> {
  const archiveUp = fs.existsSync(path.resolve(config.slpRootDir));
  const s = await getQueueState();
  if (!archiveUp) {
    await autoPause("storage_offline", `SLP root ${config.slpRootDir} is not accessible (drive not mounted?)`);
    return false;
  }
  if (s.paused && s.reason === "storage_offline") {
    await setQueueState(false, null);
    console.log("Download queue resumed: archive is back");
    sendAlertEmail("Download queue resumed", "The replay archive is accessible again.").catch(() => {});
    return true;
  }
  return !s.paused;
}
