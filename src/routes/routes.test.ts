import mongoose from "mongoose";
import express from "express";
import http from "http";
import { Replay } from "../models/Replay";
import { Job } from "../models/Job";
import replayRoutes from "./replays";
import jobRoutes from "./jobs";
import statsRoutes from "./stats";
import referenceRoutes from "./reference";
import submissionsRoutes from "./submissions";

let app: express.Express;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  await mongoose.connect("mongodb://localhost:27017/lm-database-test-routes");

  app = express();
  app.use(express.json());
  app.use("/api/replays", replayRoutes);
  app.use("/api/jobs", jobRoutes);
  app.use("/api/stats", statsRoutes);
  app.use("/api/reference", referenceRoutes);
  app.use("/api/submissions", submissionsRoutes);

  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://localhost:${addr.port}`;
});

afterAll(async () => {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await Replay.deleteMany({});
  await Job.deleteMany({});
});

async function get(path: string, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: any, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function del(path: string, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "DELETE",
    headers,
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /api/replays/estimate", () => {
  it("returns count, three-tier sizes, and ETA for a filter", async () => {
    await Replay.create({
      filePath: "/test/re1.slp", fileHash: "re1", fileSize: 80000,
      players: [
        { playerIndex: 0, connectCode: "EST#1", characterId: 2, characterName: "Fox" },
        { playerIndex: 1, connectCode: "EST#2", characterId: 9, characterName: "Marth" },
      ],
    });
    await Replay.create({
      filePath: "/test/re2.slp", fileHash: "re2", fileSize: 120000,
      players: [
        { playerIndex: 0, connectCode: "EST#1", characterId: 2, characterName: "Fox" },
        { playerIndex: 1, connectCode: "EST#3", characterId: 20, characterName: "Falco" },
      ],
    });

    const { status, body } = await post("/api/replays/estimate", {
      p1ConnectCode: "EST#1",
    });

    expect(status).toBe(200);
    expect(body.replayCount).toBe(2);
    expect(body.rawSize).toBe(200000);
    expect(body.estimatedSlpzSize).toBe(25000);
    expect(body.estimatedTarSize).toBe(25000 + 2 * 1024);
    expect(body.estimatedTimeSec).toBeGreaterThanOrEqual(0);
  });

  it("handles p1/p2 positional matching", async () => {
    await Replay.create({
      filePath: "/test/rp1.slp", fileHash: "rp1", fileSize: 100000,
      players: [
        { playerIndex: 0, connectCode: "POS#1", characterId: 2, characterName: "Fox" },
        { playerIndex: 1, connectCode: "POS#2", characterId: 9, characterName: "Marth" },
      ],
    });
    await Replay.create({
      filePath: "/test/rp2.slp", fileHash: "rp2", fileSize: 100000,
      players: [
        { playerIndex: 0, connectCode: "POS#3", characterId: 2, characterName: "Fox" },
        { playerIndex: 1, connectCode: "POS#4", characterId: 20, characterName: "Falco" },
      ],
    });

    const { status, body } = await post("/api/replays/estimate", {
      p1ConnectCode: "POS#1",
      p2ConnectCode: "POS#2",
    });

    expect(status).toBe(200);
    expect(body.replayCount).toBe(1);
  });

  it("rejects when no filter provided", async () => {
    const { status, body } = await post("/api/replays/estimate", {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/filter/i);
  });

  it("caps count with maxFiles", async () => {
    for (let i = 0; i < 10; i++) {
      await Replay.create({
        filePath: `/test/mf${i}.slp`, fileHash: `mf${i}`, fileSize: 10000,
        players: [
          { playerIndex: 0, connectCode: "MF#1", characterId: 2, characterName: "Fox" },
        ],
      });
    }

    const { status, body } = await post("/api/replays/estimate", {
      p1ConnectCode: "MF#1",
      maxFiles: 5,
    });

    expect(status).toBe(200);
    expect(body.replayCount).toBe(5);
    expect(body.rawSize).toBe(50000);
  });

  it("caps size with maxSizeMb", async () => {
    // Create 3 replays, each ~500KB
    for (let i = 0; i < 3; i++) {
      await Replay.create({
        filePath: `/test/ms${i}.slp`, fileHash: `ms${i}`, fileSize: 500 * 1024,
        players: [
          { playerIndex: 0, connectCode: "MS#1", characterId: 2, characterName: "Fox" },
        ],
      });
    }

    const { status, body } = await post("/api/replays/estimate", {
      p1ConnectCode: "MS#1",
      maxSizeMb: 1,
    });

    expect(status).toBe(200);
    // 1MB = 1048576 bytes, each file is 512000 bytes, so 2 files fit (1024000 < 1048576)
    expect(body.replayCount).toBe(2);
  });

  it("rejects maxFiles/maxSizeMb alone without a search filter", async () => {
    const { status, body } = await post("/api/replays/estimate", { maxFiles: 5 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/filter/i);
  });
});

describe("GET /api/replays", () => {
  it("returns empty list when no replays", async () => {
    const { status, body } = await get("/api/replays");

    expect(status).toBe(200);
    expect(body.replays).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  it("returns replays", async () => {
    await Replay.create({ filePath: "/test/a.slp", fileHash: "a", stageId: 31, players: [{ playerIndex: 0, connectCode: "A#1", characterId: 2, characterName: "Fox" }] });
    await Replay.create({ filePath: "/test/b.slp", fileHash: "b", stageId: 8, players: [{ playerIndex: 0, connectCode: "B#1", characterId: 9, characterName: "Marth" }] });

    const { body } = await get("/api/replays");
    expect(body.replays.length).toBe(2);
  });

  it("filters by connectCode", async () => {
    await Replay.create({
      filePath: "/test/a.slp",
      fileHash: "a",
      players: [{ playerIndex: 0, connectCode: "FOX#1", characterId: 2, characterName: "Fox" }],
    });
    await Replay.create({
      filePath: "/test/b.slp",
      fileHash: "b",
      players: [{ playerIndex: 0, connectCode: "MARTH#2", characterId: 9, characterName: "Marth" }],
    });

    const { body } = await get("/api/replays?p1ConnectCode=FOX%231");
    expect(body.replays.length).toBe(1);
    expect(body.replays[0].players[0].connectCode).toBe("FOX#1");
  });

  it("filters by stageId", async () => {
    await Replay.create({ filePath: "/test/a.slp", fileHash: "a", stageId: 31, players: [{ playerIndex: 0, connectCode: "S#1", characterId: 2, characterName: "Fox" }] });
    await Replay.create({ filePath: "/test/b.slp", fileHash: "b", stageId: 8, players: [{ playerIndex: 0, connectCode: "S#2", characterId: 9, characterName: "Marth" }] });

    const { body } = await get("/api/replays?stageId=31");
    expect(body.replays.length).toBe(1);
  });

  it("paginates correctly", async () => {
    for (let i = 0; i < 5; i++) {
      await Replay.create({ filePath: `/test/${i}.slp`, fileHash: `${i}`, stageId: 31, players: [{ playerIndex: 0, connectCode: `P${i}#1`, characterId: 2, characterName: "Fox" }] });
    }

    const { body } = await get("/api/replays?limit=2&page=1");
    expect(body.replays.length).toBe(2);
    expect(body.pagination.total).toBe(5);
    expect(body.pagination.pages).toBe(3);
  });
});

describe("GET /api/replays/:id", () => {
  it("returns a replay by id without filePath", async () => {
    const replay = await Replay.create({ filePath: "/test/x.slp", fileHash: "x" });

    const { status, body } = await get(`/api/replays/${replay._id}`);
    expect(status).toBe(200);
    expect(body.filePath).toBeUndefined();
  });

  it("returns 404 for unknown id", async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const { status } = await get(`/api/replays/${fakeId}`);
    expect(status).toBe(404);
  });
});

const TEST_CLIENT_ID = "a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4";

describe("POST /api/jobs", () => {
  const jobHeaders = { "X-Client-Id": TEST_CLIENT_ID };

  it("creates a job", async () => {
    await Replay.create({ filePath: "/test/j.slp", fileHash: "j", players: [{ playerIndex: 0, connectCode: "TEST#1", characterId: 2, characterName: "Fox" }] });
    const { status, body } = await post("/api/jobs", { p1ConnectCode: "TEST#1" }, jobHeaders);

    expect(status).toBe(201);
    expect(body.jobId).toBeDefined();
    expect(body.status).toBe("pending");
  });

  it("stores replayCount, estimatedSize, and estimatedProcessingTime at creation", async () => {
    await Replay.create({ filePath: "/test/j1.slp", fileHash: "j1", fileSize: 80000, players: [{ playerIndex: 0, connectCode: "EST#1", characterId: 2, characterName: "Fox" }] });
    await Replay.create({ filePath: "/test/j2.slp", fileHash: "j2", fileSize: 120000, players: [{ playerIndex: 0, connectCode: "EST#1", characterId: 2, characterName: "Fox" }] });

    const { body } = await post("/api/jobs", { p1ConnectCode: "EST#1" }, jobHeaders);
    const job = await Job.findById(body.jobId);

    expect(job!.replayCount).toBe(2);
    expect(job!.estimatedSize).toBe(200000);
    expect(job!.estimatedProcessingTime).toBeGreaterThanOrEqual(0);
  });

  it("stores createdBy from X-Client-Id header", async () => {
    await Replay.create({ filePath: "/test/j.slp", fileHash: "j", players: [{ playerIndex: 0, connectCode: "TEST#1", characterId: 2, characterName: "Fox" }] });
    const { body } = await post("/api/jobs", { p1ConnectCode: "TEST#1" }, jobHeaders);

    const job = await Job.findById(body.jobId);
    expect(job!.createdBy).toBe(TEST_CLIENT_ID);
  });

  it("rejects when X-Client-Id is missing", async () => {
    const { status, body } = await post("/api/jobs", { p1ConnectCode: "TEST#1" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/X-Client-Id/i);
  });

  it("rejects when X-Client-Id is not a valid UUID", async () => {
    const { status, body } = await post("/api/jobs", { p1ConnectCode: "TEST#1" }, { "X-Client-Id": "not-a-uuid" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/X-Client-Id/i);
  });

  it("rejects when no filter provided", async () => {
    const { status, body } = await post("/api/jobs", {}, jobHeaders);
    expect(status).toBe(400);
    expect(body.error).toMatch(/filter/i);
  });

  it("rejects when no replays match", async () => {
    const { status, body } = await post("/api/jobs", { p1ConnectCode: "NOBODY#0" }, jobHeaders);
    expect(status).toBe(400);
    expect(body.error).toMatch(/no replays/i);
  });

  it("stores maxFiles in filter and caps replayCount", async () => {
    for (let i = 0; i < 10; i++) {
      await Replay.create({
        filePath: `/test/jmf${i}.slp`, fileHash: `jmf${i}`, fileSize: 10000,
        players: [{ playerIndex: 0, connectCode: "JMF#1", characterId: 2, characterName: "Fox" }],
      });
    }

    const { status, body } = await post("/api/jobs", { p1ConnectCode: "JMF#1", maxFiles: 3 }, jobHeaders);
    expect(status).toBe(201);

    const job = await Job.findById(body.jobId);
    expect(job!.filter.maxFiles).toBe(3);
    expect(job!.replayCount).toBe(3);
    expect(job!.estimatedSize).toBe(30000);
  });
});

describe("GET /api/jobs", () => {
  it("requires X-Client-Id header", async () => {
    const { status, body } = await get("/api/jobs");
    expect(status).toBe(400);
    expect(body.error).toMatch(/X-Client-Id/i);
  });

  it("returns jobs for a client", async () => {
    await Job.create({ filter: { p1ConnectCode: "X#1" }, createdBy: "client-1" });
    await Job.create({ filter: { p1ConnectCode: "Y#1" }, createdBy: "client-2" });

    const { status, body } = await get("/api/jobs", { "X-Client-Id": "client-1" });
    expect(status).toBe(200);
    expect(body.jobs.length).toBe(1);
    expect(body.pagination.total).toBe(1);
  });
});

describe("DELETE /api/jobs/:id", () => {
  it("allows user to cancel own pending job", async () => {
    const job = await Job.create({ filter: { p1ConnectCode: "X#1" }, createdBy: "client-1" });

    const { status, body } = await del(`/api/jobs/${job._id}`, { "X-Client-Id": "client-1" });
    expect(status).toBe(200);
    expect(body.message).toMatch(/cancelled/i);

    const updated = await Job.findById(job._id);
    expect(updated!.status).toBe("cancelled");
  });

  it("rejects cancellation from wrong client", async () => {
    const job = await Job.create({ filter: { p1ConnectCode: "X#1" }, createdBy: "client-1" });

    const { status } = await del(`/api/jobs/${job._id}`, { "X-Client-Id": "client-2" });
    expect(status).toBe(403);
  });

  it("rejects cancellation of completed job", async () => {
    const job = await Job.create({ filter: { p1ConnectCode: "X#1" }, createdBy: "client-1", status: "completed" });

    const { status } = await del(`/api/jobs/${job._id}`, { "X-Client-Id": "client-1" });
    expect(status).toBe(400);
  });
});

describe("GET /api/jobs/:id", () => {
  it("returns job status with downloadReady flag", async () => {
    const job = await Job.create({ filter: { p1ConnectCode: "X#1" } });

    const { status, body } = await get(`/api/jobs/${job._id}`);
    expect(status).toBe(200);
    expect(body.status).toBe("pending");
    expect(body).toHaveProperty("replayCount");
    expect(body).toHaveProperty("downloadReady");
    expect(body.downloadReady).toBe(false);
    expect(body).toHaveProperty("progress");
    expect(body).toHaveProperty("queuePosition");
    expect(body).toHaveProperty("estimatedWaitSec");
    expect(body).toHaveProperty("estimatedProcessingTimeSec");
  });

  it("shows downloadReady true for completed job with r2Key", async () => {
    const job = await Job.create({
      filter: { p1ConnectCode: "X#1" },
      status: "completed",
      r2Key: "jobs/test.tar",
    });

    const { body } = await get(`/api/jobs/${job._id}`);
    expect(body.downloadReady).toBe(true);
  });

  it("returns queuePosition and ETAs for pending jobs", async () => {
    const job1 = await Job.create({ filter: { p1ConnectCode: "X#1" }, estimatedProcessingTime: 60 });
    const job2 = await Job.create({ filter: { p1ConnectCode: "Y#1" }, estimatedProcessingTime: 30 });

    // job1 is first (created earlier), job2 is second
    const { body: body1 } = await get(`/api/jobs/${job1._id}`);
    expect(body1.queuePosition).toBe(1);
    expect(body1.estimatedWaitSec).toBe(0); // nothing ahead

    const { body: body2 } = await get(`/api/jobs/${job2._id}`);
    expect(body2.queuePosition).toBe(2);
    expect(body2.estimatedWaitSec).toBe(60); // job1 ahead
  });

  it("returns queuePosition 0 for active job", async () => {
    const job = await Job.create({
      filter: { p1ConnectCode: "X#1" },
      status: "compressing",
      estimatedProcessingTime: 100,
      progress: { step: "compressing", filesProcessed: 50, filesTotal: 100 },
    });

    const { body } = await get(`/api/jobs/${job._id}`);
    expect(body.queuePosition).toBe(0);
    expect(body.estimatedWaitSec).toBe(0);
    expect(body.estimatedProcessingTimeSec).toBe(50); // 50% done, 100 * 0.5
  });

  it("returns queuePosition 0 for compressed job", async () => {
    const job = await Job.create({
      filter: { p1ConnectCode: "X#1" },
      status: "compressed",
      estimatedProcessingTime: 60,
    });

    const { body } = await get(`/api/jobs/${job._id}`);
    expect(body.queuePosition).toBe(0);
    expect(body.estimatedWaitSec).toBe(0);
  });

  it("returns null queue fields for terminal statuses", async () => {
    const job = await Job.create({ filter: { p1ConnectCode: "X#1" }, status: "completed", r2Key: "jobs/test.tar" });

    const { body } = await get(`/api/jobs/${job._id}`);
    expect(body.queuePosition).toBeNull();
    expect(body.estimatedWaitSec).toBeNull();
    expect(body.estimatedProcessingTimeSec).toBeNull();
  });

  it("priority affects queue ordering", async () => {
    // Create job1 first but with higher priority number (lower priority)
    const job1 = await Job.create({ filter: { p1ConnectCode: "X#1" }, priority: 5, estimatedProcessingTime: 60 });
    const job2 = await Job.create({ filter: { p1ConnectCode: "Y#1" }, priority: 0, estimatedProcessingTime: 30 });

    // job2 has lower priority number = processed first
    const { body: body2 } = await get(`/api/jobs/${job2._id}`);
    expect(body2.queuePosition).toBe(1);

    const { body: body1 } = await get(`/api/jobs/${job1._id}`);
    expect(body1.queuePosition).toBe(2);
    expect(body1.estimatedWaitSec).toBe(30); // job2 is ahead
  });

  it("returns 404 for unknown job", async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const { status } = await get(`/api/jobs/${fakeId}`);
    expect(status).toBe(404);
  });
});

describe("GET /api/jobs/:id/download", () => {
  it("returns 400 when bundle not ready", async () => {
    const job = await Job.create({
      filter: { p1ConnectCode: "X#1" },
      status: "processing",
    });

    const res = await fetch(`${baseUrl}/api/jobs/${job._id}/download`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/jobs/bundles", () => {
  it("returns completed jobs sorted by downloadCount", async () => {
    await Job.create({
      filter: { p1ConnectCode: "A#1" }, status: "completed", r2Key: "jobs/a.tar",
      replayCount: 10, bundleSize: 5000, downloadCount: 5, completedAt: new Date(),
    });
    await Job.create({
      filter: { p1ConnectCode: "B#1" }, status: "completed", r2Key: "jobs/b.tar",
      replayCount: 20, bundleSize: 10000, downloadCount: 15, completedAt: new Date(),
    });
    await Job.create({
      filter: { p1ConnectCode: "C#1" }, status: "pending",
      replayCount: 5, downloadCount: 0,
    });

    const { status, body } = await get("/api/jobs/bundles");
    expect(status).toBe(200);
    expect(body.bundles.length).toBe(2);
    expect(body.bundles[0].downloadCount).toBe(15);
    expect(body.bundles[1].downloadCount).toBe(5);
    expect(body.pagination.total).toBe(2);
  });

  it("paginates bundles", async () => {
    for (let i = 0; i < 3; i++) {
      await Job.create({
        filter: { p1ConnectCode: `P${i}#1` }, status: "completed", r2Key: `jobs/p${i}.tar`,
        replayCount: 10, bundleSize: 5000, downloadCount: i, completedAt: new Date(),
      });
    }

    const { body } = await get("/api/jobs/bundles?limit=2&page=1");
    expect(body.bundles.length).toBe(2);
    expect(body.pagination.pages).toBe(2);
  });
});

describe("GET /api/jobs/:id/download — download count", () => {
  it("increments downloadCount on each download", async () => {
    const job = await Job.create({
      filter: { p1ConnectCode: "X#1" }, status: "completed",
      r2Key: "jobs/test.tar", downloadCount: 0,
    });

    // The download will fail since R2 is not configured in tests,
    // but the increment happens before the presigned URL generation,
    // so we verify by checking the DB after the attempt
    await fetch(`${baseUrl}/api/jobs/${job._id}/download`, { redirect: "manual" });

    // Poll for the fire-and-forget update to complete (up to 2s)
    let updated;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      updated = await Job.findById(job._id);
      if (updated!.downloadCount > 0) break;
    }
    expect(updated!.downloadCount).toBe(1);
  });
});

describe("POST /api/submissions/:id/approve", () => {
  it("returns 401 without auth", async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const { status, body } = await post(`/api/submissions/${fakeId}/approve`, {});
    expect(status).toBe(401);
    expect(body.error).toMatch(/authentication/i);
  });
});

describe("POST /api/submissions/:id/reject", () => {
  it("returns 401 without auth", async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const { status, body } = await post(`/api/submissions/${fakeId}/reject`, {});
    expect(status).toBe(401);
    expect(body.error).toMatch(/authentication/i);
  });
});

describe("GET /api/stats", () => {
  it("returns replay count and job counts", async () => {
    await Replay.create({ filePath: "/test/s.slp", fileHash: "s", stageId: 31, players: [{ playerIndex: 0, connectCode: "S#1", characterId: 2, characterName: "Fox" }] });
    await Job.create({ filter: {} });

    const { status, body } = await get("/api/stats");
    expect(status).toBe(200);
    expect(body.replays).toBe(1);
    expect(body.jobs).toBeDefined();
  });
});

describe("GET /api/reference", () => {
  it("returns characters", async () => {
    const { status, body } = await get("/api/reference/characters");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("name");
  });

  it("returns stages", async () => {
    const { status, body } = await get("/api/reference/stages");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("name");
  });
});
