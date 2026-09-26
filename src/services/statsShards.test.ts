import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import mongoose from "mongoose";
import { Replay } from "../models/Replay";
import { StatsShard } from "../models/StatsShard";
import {
  MAX_ATTEMPTS,
  claimShard,
  commitShard,
  failShard,
  planShards,
  publishDetailFile,
  releaseShard,
  renewLease,
  shardStatusCounts,
} from "./statsShards";

const V = 99;
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
    const shards = await StatsShard.find({ version: V }).sort({ fromId: 1 }).lean();
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
    expect(await commitShard(a!._id, "a", { games: 2, failedGames: 0, file: "f", bytes: 1, sha256: "s", parser: "p" })).toBe(false);
    expect(await commitShard(b!._id, "b", { games: 2, failedGames: 0, file: "f", bytes: 1, sha256: "s", parser: "p" })).toBe(true);
    expect((await StatsShard.findById(b!._id).lean())!.status).toBe("committed");
  });

  it("never hands out committed shards", async () => {
    for (const owner of ["a", "b"]) {
      const s = await claimShard(V, owner, LEASE);
      await commitShard(s!._id, owner, { games: 2, failedGames: 0, file: "f", bytes: 1, sha256: "s", parser: "p" });
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
