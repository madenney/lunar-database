import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import mongoose from "mongoose";
import { Replay } from "../models/Replay";
import { StatsShard } from "../models/StatsShard";
import { GameStats, statsCollection } from "../models/GameStats";
import { extractGame, EXTRACTORS } from "./gameStats";
import { StatsRun } from "../models/StatsRun";
import {
  MAX_ATTEMPTS,
  assertRunMatchesCode,
  ensureRun,
  claimShard,
  commitShard,
  failShard,
  planShards,
  planRetryShards,
  publishDetailFile,
  releaseShard,
  renewLease,
  shardStatusCounts,
} from "./statsShards";

const V = "test-run";
const LEASE = 60_000;

beforeAll(async () => {
  await mongoose.connect(`${process.env.TEST_MONGODB_URL ?? "mongodb://localhost:27017"}/lm-database-test-stats-shards`);
});
afterAll(async () => {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
});
beforeEach(async () => {
  await Replay.deleteMany({});
  await StatsShard.deleteMany({});
});

async function addReplays(n: number, usable = true) {
  const docs = Array.from({ length: n }, (_, i) => ({
    filePath: `t/${new mongoose.Types.ObjectId()}-${i}.slp`,
    fileHash: `h-${new mongoose.Types.ObjectId()}`,
    usable,
  }));
  await Replay.collection.insertMany(docs);
}

describe("planShards", () => {
  it("cuts usable replays into ranges and only plans new ones when rerun", async () => {
    await addReplays(12);
    await addReplays(3, false);
    expect(await planShards(V, 5)).toBe(3);
    const shards = await StatsShard.find({ run: V }).sort({ fromId: 1 }).lean();
    expect(shards.map((s) => s.planned)).toEqual([5, 5, 2]);

    expect(await planShards(V, 5)).toBe(0);
    await addReplays(4);
    expect(await planShards(V, 5)).toBe(1);
    expect((await shardStatusCounts(V)).pending).toEqual({ shards: 4, games: 16 });
  });
});

describe("claims and leases", () => {
  beforeEach(async () => {
    await addReplays(4);
    await planShards(V, 2);
  });

  it("gives each runner a different shard and none once all are taken", async () => {
    const a = await claimShard(V, "a", LEASE);
    const b = await claimShard(V, "b", LEASE);
    expect(a!._id).not.toBe(b!._id);
    expect(await claimShard(V, "c", LEASE)).toBeNull();
  });

  it("reclaims a shard whose lease expired, and the old owner can no longer commit", async () => {
    await claimShard(V, "x", LEASE); // hold the first shard
    const a = await claimShard(V, "a", -1); // already expired
    const b = await claimShard(V, "b", LEASE);
    expect(b!._id).toBe(a!._id);
    expect(b!.attempts).toBe(2);
    expect(await renewLease(a!._id, "a", LEASE)).toBe(false);
    expect(await commitShard(a!._id, "a", { games: 2, failedGames: 0, files: {}, parser: "p" })).toBe(false);
    expect(await commitShard(b!._id, "b", { games: 2, failedGames: 0, files: {}, parser: "p" })).toBe(true);
    expect((await StatsShard.findById(b!._id).lean())!.status).toBe("committed");
  });

  it("never hands out committed shards", async () => {
    for (const owner of ["a", "b"]) {
      const s = await claimShard(V, owner, LEASE);
      await commitShard(s!._id, owner, { games: 2, failedGames: 0, files: {}, parser: "p" });
    }
    expect(await claimShard(V, "c", -1)).toBeNull();
  });

  it("releases a shard without spending an attempt", async () => {
    const a = await claimShard(V, "a", LEASE);
    await releaseShard(a!._id, "a");
    const again = await StatsShard.findById(a!._id).lean();
    expect(again).toMatchObject({ status: "pending", owner: null, attempts: 0 });
  });

  it("retries failed shards a limited number of times", async () => {
    await StatsShard.deleteMany({ _id: { $ne: (await StatsShard.findOne().sort({ fromId: 1 }))!._id } });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const s = await claimShard(V, "a", LEASE);
      expect(s).not.toBeNull();
      await failShard(s!._id, "a", "boom");
    }
    expect(await claimShard(V, "a", LEASE)).toBeNull();
    expect((await StatsShard.findOne().lean())!.lastError).toBe("boom");
  });
});

describe("publishDetailFile", () => {
  it("writes the gzip atomically with a stable checksum and no temp file left", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-shard-"));
    try {
      const lines = ['{"r":"a","c":[]}\n', '{"r":"b","c":[[0,1,2,3,4,5,6,0,1]]}\n'];
      const first = publishDetailFile(dir, "s.jsonl.gz", lines, "host-1");
      const second = publishDetailFile(dir, "s.jsonl.gz", lines, "host/2");
      expect(second).toEqual(first);
      expect(fs.readdirSync(dir)).toEqual(["s.jsonl.gz"]);
      expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, "s.jsonl.gz"))).toString()).toBe(lines.join(""));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("statsCollection", () => {
  const saved = process.env.STATS_NAMESPACE;
  afterEach(() => {
    if (saved === undefined) delete process.env.STATS_NAMESPACE;
    else process.env.STATS_NAMESPACE = saved;
  });

  it("keeps a namespaced run apart from the published collections", () => {
    delete process.env.STATS_NAMESPACE;
    expect(statsCollection("gameStats")).toBe("gameStats");
    process.env.STATS_NAMESPACE = "pilot";
    expect(statsCollection("gameStats")).toBe("gameStats_pilot");
    process.env.STATS_NAMESPACE = "../x";
    expect(() => statsCollection("gameStats")).toThrow(/Invalid STATS_NAMESPACE/);
  });
});

describe("runs", () => {
  afterEach(async () => {
    await StatsRun.deleteMany({});
  });

  it("records the code's extractor versions and returns the same run when planned again", async () => {
    const run = await ensureRun("main", ["core", "clipper"], "parser@1", "me");
    expect(run.extractors).toEqual({ core: EXTRACTORS.core, clipper: EXTRACTORS.clipper });
    expect((await ensureRun("main", ["core"], "parser@1", "me")).extractors).toEqual(run.extractors);
  });

  it("refuses a second run for an extractor version another run computes", async () => {
    await ensureRun("main", ["core", "clipper"], "p", "me");
    await expect(ensureRun("again", ["clipper"], "p", "me")).rejects.toThrow(/already computes clipper/);
    await expect(ensureRun("addon", ["identity"], "p", "me")).resolves.toBeTruthy();
  });

  it("rejects bad run names and runs whose versions no longer match the code", async () => {
    await expect(ensureRun("../x", ["core"], "p", "me")).rejects.toThrow(/Invalid run name/);
    expect(() => assertRunMatchesCode({ _id: "old", extractors: { core: EXTRACTORS.core - 1 } })).toThrow(/start a new run/);
  });
});

describe("GameStats writes", () => {
  it("keep every extracted field, and a later run adds to the record without removing others", async () => {
    const x = extractGame(path.join(__dirname, "../__fixtures__/test.slp"));
    const replayId = new mongoose.Types.ObjectId();
    const write = (set: Record<string, unknown>) =>
      GameStats.collection.updateOne({ replayId }, { $set: { filePath: "t.slp", extractedAt: new Date(), ...set } }, { upsert: true });
    const { contentHash, fingerprint, gecko, ...rest } = x.fields;
    await write({ ...rest, "extractors.core": 2 });
    await write({ contentHash, fingerprint, gecko, "extractors.identity": 1 });
    const stored = await GameStats.collection.findOne({ replayId });
    for (const key of Object.keys(x.fields)) expect(stored).toHaveProperty(key);
    expect(stored!.match).toEqual(x.fields.match);
    expect(stored!.extractors).toEqual({ core: 2, identity: 1 });
    await GameStats.deleteMany({});
  });
});

describe("planRetryShards", () => {
  afterEach(async () => {
    await GameStats.deleteMany({});
  });

  it("queues only the games that errored, as shards listing their replays", async () => {
    const ok = new mongoose.Types.ObjectId();
    const bad = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    await GameStats.collection.insertMany([
      { replayId: ok, filePath: "ok", error: null, extractedAt: new Date() },
      ...bad.map((replayId) => ({ replayId, filePath: "bad", error: "boom", extractedAt: new Date() })),
    ]);
    expect(await planRetryShards(V, 2)).toBe(3);
    const shards = await StatsShard.find({ run: V, replayIds: { $exists: true } }).sort({ _id: 1 }).lean();
    expect(shards.map((s) => s.planned)).toEqual([2, 1]);
    expect(shards.flatMap((s) => s.replayIds!.map(String)).sort()).toEqual(bad.map(String).sort());
    expect(shards.every((s) => s.status === "pending" && s._id.startsWith(`${V}-retry`))).toBe(true);
  });
});
