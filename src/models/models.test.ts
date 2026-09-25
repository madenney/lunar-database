import mongoose from "mongoose";
import { Replay } from "./Replay";
import { Job } from "./Job";
import { Submission } from "./Submission";
import { Upload } from "./Upload";
import { saveBatch } from "../services/crawler";

beforeAll(async () => {
  await mongoose.connect(`${process.env.TEST_MONGODB_URL ?? "mongodb://localhost:27017"}/lm-database-test`);
  // Ensure indexes are built so unique constraints work in tests
  await Replay.syncIndexes();
  await Job.syncIndexes();
  await Submission.syncIndexes();
  await Upload.syncIndexes();
});

afterAll(async () => {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
});

afterEach(async () => {
  await Replay.deleteMany({});
  await Job.deleteMany({});
  await Submission.deleteMany({});
  await Upload.deleteMany({});
});

describe("Replay insertMany (crawler path)", () => {
  const doc = (i: number, extra: Record<string, unknown> = {}) => ({
    filePath: `/bulk/${i}.slp`, fileHash: `bulk${i}`, stageId: 31, duration: 3600,
    players: [{ playerIndex: 0, connectCode: `B#${i}`, characterId: 2, characterName: "Fox" }],
    ...extra,
  });

  it("inserts with the real hook and materialises usable", async () => {
    await Replay.insertMany([doc(1), doc(2, { duration: 0 })]);
    const rows = await Replay.find({ filePath: /^\/bulk\// }).sort({ filePath: 1 }).lean();
    expect(rows.map((r) => r.usable)).toEqual([true, false]);
  });

  it("saveBatch tolerates re-inserting existing files", async () => {
    await saveBatch([doc(3)]);
    expect(await saveBatch([doc(3), doc(4)])).toEqual({ nonDupErrors: 0 });
    expect(await Replay.countDocuments({ filePath: { $in: ["/bulk/3.slp", "/bulk/4.slp"] } })).toBe(2);
  });
});

describe("Replay model", () => {
  it("creates a replay with required fields", async () => {
    const replay = await Replay.create({
      filePath: "/test/game.slp",
      fileHash: "abc123",
      stageId: 31,
      stageName: "Battlefield",
      players: [
        { playerIndex: 0, connectCode: "FOX#123", displayName: "Fox", tag: null, characterId: 2, characterName: "Fox" },
        { playerIndex: 1, connectCode: "FACO#456", displayName: "Falco", tag: null, characterId: 20, characterName: "Falco" },
      ],
    });

    expect(replay._id).toBeDefined();
    expect(replay.filePath).toBe("/test/game.slp");
    expect(replay.players.length).toBe(2);
    expect(replay.players[0].connectCode).toBe("FOX#123");
  });

  it("enforces unique filePath", async () => {
    await Replay.create({ filePath: "/test/dupe.slp", fileHash: "abc" });

    await expect(
      Replay.create({ filePath: "/test/dupe.slp", fileHash: "def" })
    ).rejects.toThrow();
  });

  it("defaults optional fields to null", async () => {
    const replay = await Replay.create({ filePath: "/test/minimal.slp", fileHash: "xyz" });

    expect(replay.stageId).toBeNull();
    expect(replay.stageName).toBeNull();
    expect(replay.startAt).toBeNull();
    expect(replay.duration).toBeNull();
    expect(replay.winner).toBeNull();
    expect(replay.folderLabel).toBeNull();
  });
});

describe("Job model", () => {
  it("creates a job with default status pending", async () => {
    const job = await Job.create({
      filter: { p1ConnectCode: "TEST#123" },
    });

    expect(job.status).toBe("pending");
    expect(job.filter.p1ConnectCode).toBe("TEST#123");
    expect(job.bundlePath).toBeNull();
  });

  it("stores filter fields", async () => {
    const job = await Job.create({
      filter: {
        p1ConnectCode: "A#1",
        p1CharacterId: "2",
        stageId: "31",
        startDate: "2023-01-01",
        endDate: "2024-01-01",
      },
    });

    expect(job.filter.p1ConnectCode).toBe("A#1");
    expect(job.filter.p1CharacterId).toBe("2");
    expect(job.filter.stageId).toBe("31");
  });
});

describe("Submission model", () => {
  it("creates a submission with default status pending", async () => {
    const sub = await Submission.create({
      originalFilename: "game.slp",
      airlockPath: "/airlock/game.slp",
      submittedBy: "tester",
    });

    expect(sub.status).toBe("pending");
    expect(sub.originalFilename).toBe("game.slp");
    expect(sub.replayId).toBeNull();
  });

  it("links to an upload", async () => {
    const upload = await Upload.create({
      originalFilename: "batch.zip",
      diskPath: "/airlock/batch.zip",
    });

    const sub = await Submission.create({
      uploadId: upload._id,
      originalFilename: "game.slp",
      airlockPath: "/airlock/game.slp",
    });

    expect(sub.uploadId!.toString()).toBe(upload._id.toString());
  });
});

describe("Upload model", () => {
  it("creates an upload with default status uploading", async () => {
    const upload = await Upload.create({
      originalFilename: "replays.zip",
      diskPath: "/airlock/replays.zip",
    });

    expect(upload.status).toBe("uploading");
    expect(upload.slpCount).toBe(0);
    expect(upload.error).toBeNull();
  });
});
