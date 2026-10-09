import mongoose from "mongoose";
import express from "express";
import http from "http";
import { config } from "../config";
import { Replay } from "../models/Replay";
import { identifyServiceCaller } from "../middleware/serviceCaller";

jest.mock("../services/fullDbArchive", () => ({
  currentSnapshotId: jest.fn(async () => "archive/lunar_db_full.zip@etag-now"),
  archiveUrl: jest.fn(async () => "https://storage.example/archive/lunar_db_full.zip?sig=1"),
}));
import replayRoutes from "./replays";

const KEY = "test-service-key-0123456789abcdef";
let server: http.Server;
let base: string;
const prevKey = config.serviceKey;

beforeAll(async () => {
  await mongoose.connect(`${process.env.TEST_MONGODB_URL ?? "mongodb://localhost:27017"}/lm-database-test-replay-source`);
  (config as any).serviceKey = KEY;
  const app = express();
  app.use(identifyServiceCaller);
  app.use("/api/replays", replayRoutes);
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://localhost:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  (config as any).serviceKey = prevKey;
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const get = (id: string, key?: string) =>
  fetch(`${base}/api/replays/${id}/source`, { headers: key ? { "X-Lunar-Service-Key": key } : {} });
const json = async (r: Promise<Response>): Promise<any> => (await r).json();

describe("GET /api/replays/:id/source", () => {
  it("answers only the website, and only with a location from the current zip", async () => {
    const located = await Replay.create({
      filePath: "tournament/G9/Game_1.slp", fileHash: "s1", fileSize: 4_000_000, players: [],
      archive: { snapshot: "archive/lunar_db_full.zip@etag-now", offset: 12345, length: 678, format: "slpz" },
    });
    const stale = await Replay.create({
      filePath: "tournament/G9/Game_2.slp", fileHash: "s2", players: [],
      archive: { snapshot: "archive/lunar_db_full.zip@etag-old", offset: 1, length: 2, format: "slpz" },
    });
    const none = await Replay.create({ filePath: "netplay/new/Game_3.slp", fileHash: "s3", players: [] });

    expect((await get(String(located._id))).status).toBe(403); // not the website
    const ok = await json(get(String(located._id), KEY));
    expect(ok.source).toEqual({
      url: "https://storage.example/archive/lunar_db_full.zip?sig=1",
      offset: 12345,
      length: 678,
      format: "slpz",
      filename: "Game_1.slp",
    });
    expect((await json(get(String(stale._id), KEY))).source).toBeNull();
    expect((await json(get(String(none._id), KEY))).source).toBeNull();
    expect((await get("not-an-id", KEY)).status).toBe(404);
  });
});

describe("GET /api/replays/:id/download for direct API callers", () => {
  it("sends a replay in the current zip to the website's storage-backed copy", async () => {
    const r = await Replay.create({
      filePath: "tournament/G9/Game_4.slp", fileHash: "s4", players: [],
      archive: { snapshot: "archive/lunar_db_full.zip@etag-now", offset: 1, length: 2, format: "slpz" },
    });
    const direct = await fetch(`${base}/api/replays/${r._id}/download`, { redirect: "manual" });
    expect(direct.status).toBe(302);
    expect(direct.headers.get("location")).toBe(`${config.publicSiteUrl}/api/download?action=replay&replayId=${r._id}`);
    // The website itself (falling back here) is never sent back to itself.
    const website = await fetch(`${base}/api/replays/${r._id}/download`, { redirect: "manual", headers: { "X-Lunar-Service-Key": KEY } });
    expect(website.status).not.toBe(302);
    expect((await fetch(`${base}/api/replays/not-an-id/download`, { redirect: "manual" })).status).toBe(404);
  });
});
