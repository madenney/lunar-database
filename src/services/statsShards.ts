import crypto from "crypto";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import mongoose from "mongoose";
import { Replay } from "../models/Replay";
import { StatsShard, IStatsShard } from "../models/StatsShard";

/**
 * Work allocation and publication for scripts/extractStats.ts.
 *
 * Usable replays are cut into fixed ID ranges (shards). A runner on any machine
 * claims a shard with an expiring lease, extracts it, publishes its detail file,
 * writes the summaries, then commits the shard. A shard that is never committed
 * (crash, lost lease, write failure) is claimed again later, so completion never
 * depends on summaries alone.
 */

/** Failed shards are retried this many times in total before being left alone. */
export const MAX_ATTEMPTS = 3;

export const shardId = (version: number, fromId: mongoose.Types.ObjectId | string) => `v${version}-${fromId}`;

/**
 * Plan shards for usable replays after the last planned range. Idempotent: run it
 * again after a crawl to cover new replays. Run it from one machine at a time.
 */
export async function planShards(version: number, size: number): Promise<number> {
  const last = await StatsShard.findOne({ version }).sort({ toId: -1 }).select("toId").lean();
  const match: Record<string, unknown> = { usable: true };
  if (last) match._id = { $gt: last.toId };
  const cursor = Replay.find(match).sort({ _id: 1 }).select("_id").lean().cursor({ batchSize: 10_000 });

  let chunk: mongoose.Types.ObjectId[] = [];
  let created = 0;
  const save = async () => {
    if (!chunk.length) return;
    const fromId = chunk[0];
    await StatsShard.create({
      _id: shardId(version, fromId),
      version,
      fromId,
      toId: chunk[chunk.length - 1],
      planned: chunk.length,
    });
    created++;
    chunk = [];
  };
  for await (const doc of cursor) {
    chunk.push(doc._id as mongoose.Types.ObjectId);
    if (chunk.length >= size) await save();
  }
  await save();
  return created;
}

/** Claim the next available shard, or null when none is left. */
export async function claimShard(version: number, owner: string, leaseMs: number): Promise<IStatsShard | null> {
  const now = new Date();
  return StatsShard.findOneAndUpdate(
    {
      version,
      $or: [
        { status: "pending" },
        { status: "running", leaseUntil: { $lt: now } },
        { status: "failed", attempts: { $lt: MAX_ATTEMPTS } },
      ],
    },
    { $set: { status: "running", owner, leaseUntil: new Date(now.getTime() + leaseMs) }, $inc: { attempts: 1 } },
    { sort: { fromId: 1 }, new: true }
  );
}

/** Extend a lease. Returns false if another runner has taken the shard. */
export async function renewLease(id: string, owner: string, leaseMs: number): Promise<boolean> {
  const r = await StatsShard.updateOne(
    { _id: id, owner, status: "running" },
    { $set: { leaseUntil: new Date(Date.now() + leaseMs) } }
  );
  return r.matchedCount === 1;
}

/** Hand a shard back untouched (graceful stop), without spending an attempt. */
export async function releaseShard(id: string, owner: string): Promise<void> {
  await StatsShard.updateOne(
    { _id: id, owner, status: "running" },
    { $set: { status: "pending", owner: null, leaseUntil: null }, $inc: { attempts: -1 } }
  );
}

export async function failShard(id: string, owner: string, error: string): Promise<void> {
  await StatsShard.updateOne(
    { _id: id, owner, status: "running" },
    { $set: { status: "failed", owner: null, leaseUntil: null, lastError: error.slice(0, 500) } }
  );
}

export type ShardCommit = Pick<IStatsShard, "games" | "failedGames" | "file" | "bytes" | "sha256" | "parser">;

/** Mark a shard committed. Returns false if the lease was lost (another runner redoes it). */
export async function commitShard(id: string, owner: string, result: ShardCommit): Promise<boolean> {
  const r = await StatsShard.updateOne(
    { _id: id, owner, status: "running" },
    { $set: { ...result, status: "committed", leaseUntil: null, lastError: null, committedAt: new Date() } }
  );
  return r.matchedCount === 1;
}

export async function shardStatusCounts(version: number): Promise<Record<string, { shards: number; games: number }>> {
  const rows = await StatsShard.aggregate([
    { $match: { version } },
    { $group: { _id: "$status", shards: { $sum: 1 }, games: { $sum: "$planned" } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, { shards: r.shards, games: r.games }]));
}

/**
 * Write a shard's detail lines durably: gzip in memory, write a temp file, fsync,
 * rename into place, fsync the directory. The content is deterministic for the same
 * lines, so a retry by another runner produces the same file under the same name.
 */
export function publishDetailFile(
  dir: string,
  name: string,
  lines: string[],
  owner: string
): { bytes: number; sha256: string } {
  fs.mkdirSync(dir, { recursive: true });
  const data = zlib.gzipSync(Buffer.from(lines.join("")));
  const final = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.${owner.replace(/[^\w.-]/g, "_")}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    for (let off = 0; off < data.length; ) off += fs.writeSync(fd, data, off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, final);
  // Persist the rename. Some network filesystems can't fsync a directory; the file
  // itself is already durable there.
  try {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {}
  return { bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
}
