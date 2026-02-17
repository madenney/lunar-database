import mongoose from "mongoose";
import express from "express";
import http from "http";
import { Replay } from "../models/Replay";
import { Job } from "../models/Job";
import replayRoutes from "./replays";
import jobRoutes from "./jobs";
import statsRoutes from "./stats";
import referenceRoutes from "./reference";

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

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: any): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("GET /api/replays", () => {
  it("returns empty list when no replays", async () => {
    const { status, body } = await get("/api/replays");

    expect(status).toBe(200);
    expect(body.replays).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  it("returns replays", async () => {
    await Replay.create({ filePath: "/test/a.slp", fileHash: "a" });
    await Replay.create({ filePath: "/test/b.slp", fileHash: "b" });

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

    const { body } = await get("/api/replays?connectCode=FOX%231");
    expect(body.replays.length).toBe(1);
    expect(body.replays[0].players[0].connectCode).toBe("FOX#1");
  });

  it("filters by stageId", async () => {
    await Replay.create({ filePath: "/test/a.slp", fileHash: "a", stageId: 31 });
    await Replay.create({ filePath: "/test/b.slp", fileHash: "b", stageId: 8 });

    const { body } = await get("/api/replays?stageId=31");
    expect(body.replays.length).toBe(1);
  });

  it("paginates correctly", async () => {
    for (let i = 0; i < 5; i++) {
      await Replay.create({ filePath: `/test/${i}.slp`, fileHash: `${i}` });
    }

    const { body } = await get("/api/replays?limit=2&page=1");
    expect(body.replays.length).toBe(2);
    expect(body.pagination.total).toBe(5);
    expect(body.pagination.pages).toBe(3);
  });
});

describe("GET /api/replays/:id", () => {
  it("returns a replay by id", async () => {
    const replay = await Replay.create({ filePath: "/test/x.slp", fileHash: "x" });

    const { status, body } = await get(`/api/replays/${replay._id}`);
    expect(status).toBe(200);
    expect(body.filePath).toBe("/test/x.slp");
  });

  it("returns 404 for unknown id", async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const { status } = await get(`/api/replays/${fakeId}`);
    expect(status).toBe(404);
  });
});

describe("POST /api/jobs/estimate", () => {
  it("returns estimate for a filter", async () => {
    await Replay.create({ filePath: "/test/e1.slp", fileHash: "e1", fileSize: 80000, players: [{ playerIndex: 0, connectCode: "EST#1", characterId: 2, characterName: "Fox" }] });
    await Replay.create({ filePath: "/test/e2.slp", fileHash: "e2", fileSize: 120000, players: [{ playerIndex: 0, connectCode: "EST#1", characterId: 2, characterName: "Fox" }] });

    const { status, body } = await post("/api/jobs/estimate", { connectCode: "EST#1" });

    expect(status).toBe(200);
    expect(body.replayCount).toBe(2);
    expect(body.rawSize).toBe(200000);
    expect(body.estimatedCompressedSize).toBe(25000); // 200000 / 8
    expect(body.exceedsLimit).toBe(false);
    expect(body.limit).toBeDefined();
  });

  it("rejects when no filter provided", async () => {
    const { status, body } = await post("/api/jobs/estimate", {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/filter/i);
  });
});

describe("POST /api/jobs", () => {
  it("creates a job", async () => {
    await Replay.create({ filePath: "/test/j.slp", fileHash: "j", players: [{ playerIndex: 0, connectCode: "TEST#1", characterId: 2, characterName: "Fox" }] });
    const { status, body } = await post("/api/jobs", { connectCode: "TEST#1" });

    expect(status).toBe(201);
    expect(body.jobId).toBeDefined();
    expect(body.status).toBe("pending");
  });

  it("rejects when no filter provided", async () => {
    const { status, body } = await post("/api/jobs", {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/filter/i);
  });

  it("rejects when no replays match", async () => {
    const { status, body } = await post("/api/jobs", { connectCode: "NOBODY#0" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no replays/i);
  });
});

describe("GET /api/jobs/:id", () => {
  it("returns job status with new fields", async () => {
    const job = await Job.create({ filter: { connectCode: "X#1" } });

    const { status, body } = await get(`/api/jobs/${job._id}`);
    expect(status).toBe(200);
    expect(body.status).toBe("pending");
    expect(body).toHaveProperty("replayCount");
    expect(body).toHaveProperty("downloadUrl");
    expect(body).toHaveProperty("expiresAt");
    expect(body).toHaveProperty("progress");
  });

  it("lazily marks expired jobs", async () => {
    const job = await Job.create({
      filter: { connectCode: "X#1" },
      status: "completed",
      downloadUrl: "https://example.com/old",
      expiresAt: new Date(Date.now() - 1000), // already expired
    });

    const { status, body } = await get(`/api/jobs/${job._id}`);
    expect(status).toBe(200);
    expect(body.status).toBe("expired");
    expect(body.downloadUrl).toBeNull();
  });

  it("returns 404 for unknown job", async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const { status } = await get(`/api/jobs/${fakeId}`);
    expect(status).toBe(404);
  });
});

describe("GET /api/jobs/:id/download", () => {
  it("returns 410 for expired jobs", async () => {
    const job = await Job.create({
      filter: { connectCode: "X#1" },
      status: "expired",
    });

    const res = await fetch(`${baseUrl}/api/jobs/${job._id}/download`, { redirect: "manual" });
    expect(res.status).toBe(410);
  });

  it("returns 400 when bundle not ready", async () => {
    const job = await Job.create({
      filter: { connectCode: "X#1" },
      status: "processing",
    });

    const res = await fetch(`${baseUrl}/api/jobs/${job._id}/download`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/stats", () => {
  it("returns replay count and job counts", async () => {
    await Replay.create({ filePath: "/test/s.slp", fileHash: "s" });
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
