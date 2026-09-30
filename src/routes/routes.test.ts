import mongoose from "mongoose";
import express from "express";
import http from "http";
import { Replay } from "../models/Replay";
import { Job } from "../models/Job";
import { DownloadEvent } from "../models/DownloadEvent";
import { config } from "../config";
import { resolveSelection } from "../services/replaySearchQuery";
import replayRoutes from "./replays";
import jobRoutes from "./jobs";
import statsRoutes, { clearStatsCache } from "./stats";
import referenceRoutes from "./reference";
import submissionsRoutes from "./submissions";
import playersRoutes from "./players";
import tournamentRoutes, { setsRouter } from "./tournaments";
import clipRoutes from "./clips";
import { Tournament } from "../models/Tournament";
import { TournamentSet } from "../models/TournamentSet";
import { Player } from "../models/Player";
import { GameStats } from "../models/GameStats";
import { PlayerStats } from "../models/PlayerStats";
import { clearGameDetailCache, detailFile } from "../services/gameDetail";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";

let app: express.Express;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  await mongoose.connect(`${process.env.TEST_MONGODB_URL ?? "mongodb://localhost:27017"}/lm-database-test-routes`);
  // Searches force some indexes (selectionHint), so they must exist before the first request.
  await Replay.init();

  app = express();
  app.use(express.json());
  app.use("/api/replays", replayRoutes);
  app.use("/api/jobs", jobRoutes);
  app.use("/api/stats", statsRoutes);
  app.use("/api/reference", referenceRoutes);
  app.use("/api/submissions", submissionsRoutes);
  app.use("/api/players", playersRoutes);
  app.use("/api/tournaments", tournamentRoutes);
  app.use("/api/sets", setsRouter);
  app.use("/api/clips", clipRoutes);

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
  await DownloadEvent.deleteMany({});
});

// Seed a full-DB download event for the throttle tests. Uses the raw collection
// so we can backdate `createdAt` past mongoose's timestamps plugin.
async function seedFullDbEvent(clientId: string, ageMs = 0): Promise<void> {
  await DownloadEvent.collection.insertOne({
    type: "full_db",
    jobId: null,
    replayId: null,
    clientId,
    bundleSize: 1_000_000_000_000,
    replayCount: null,
    createdAt: new Date(Date.now() - ageMs),
  });
}

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
    expect(body.estimatedZipSize).toBe(25000 + 2 * 128);
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

  it("accepts a limit alone (a maxFiles bound is enough to estimate)", async () => {
    const { status, body } = await post("/api/replays/estimate", { maxFiles: 5 });
    expect(status).toBe(200);
    expect(typeof body.replayCount).toBe("number");
  });

  it("rejects an empty request (no filter and no limit)", async () => {
    const { status, body } = await post("/api/replays/estimate", {});
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
    for (const r of body.replays) {
      expect(r).not.toHaveProperty("filePath");
      expect(r).not.toHaveProperty("folderLabel");
    }
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

describe("selection consistency", () => {
  const replay = (i: number, extra: Record<string, any>) =>
    Replay.create({
      filePath: `/test/sel${i}.slp`, fileHash: `sel${i}`, fileSize: 1000, stageId: 31,
      players: [{ playerIndex: 0, connectCode: `S${i}#1`, characterId: 2, characterName: "Fox" }],
      ...extra,
    });

  it("keeps undated replays for oldest-first when nothing is dated (ranked)", async () => {
    for (let i = 0; i < 3; i++) await replay(i, { source: "ranked", startAt: null });

    const list = await get("/api/replays?source=ranked&sort=startAt:1");
    expect(list.body.pagination.total).toBe(3);

    const estimate = await post("/api/replays/estimate", { source: "ranked", sort: "startAt:1", maxFiles: 2 });
    expect(estimate.body.replayCount).toBe(2);

    // The bundle worker reads this same selection.
    const { query } = await resolveSelection({ source: "ranked", sort: "startAt:1" });
    expect(await Replay.countDocuments(query)).toBe(3);
  });

  it("excludes undated replays for oldest-first when dated ones exist, everywhere", async () => {
    await replay(0, { source: "netplay", startAt: new Date("2023-05-01T00:00:00Z") });
    await replay(1, { source: "netplay", startAt: null });
    await replay(2, { source: "netplay", startAt: null });

    const list = await get("/api/replays?source=netplay&sort=startAt:1");
    expect(list.body.pagination.total).toBe(1);

    const estimate = await post("/api/replays/estimate", { source: "netplay", sort: "startAt:1", maxFiles: 5 });
    expect(estimate.body.replayCount).toBe(1);
  });

  it("includes the whole end date", async () => {
    await replay(0, { startAt: new Date("2024-01-15T18:00:00Z") });
    await replay(1, { startAt: new Date("2024-01-16T00:00:00Z") });

    const { body } = await get("/api/replays?startDate=2024-01-15&endDate=2024-01-15");
    expect(body.pagination.total).toBe(1);
  });

  it("does not let one player satisfy both sides of a matchup", async () => {
    await replay(0, {
      players: [
        { playerIndex: 0, connectCode: "A#1", characterId: 2, characterName: "Fox" },
        { playerIndex: 1, connectCode: "B#1", characterId: 9, characterName: "Marth" },
      ],
    });
    await replay(1, {
      players: [
        { playerIndex: 0, connectCode: "C#1", characterId: 9, characterName: "Marth" },
        { playerIndex: 1, connectCode: "D#1", characterId: 9, characterName: "Marth" },
        { playerIndex: 2, connectCode: "E#1", characterId: 2, characterName: "Fox" },
        { playerIndex: 3, connectCode: "F#1", characterId: 2, characterName: "Fox" },
      ],
    });

    const foxVsFox = await get("/api/replays?p1CharacterId=2&p2CharacterId=2");
    expect(foxVsFox.body.pagination.total).toBe(1); // only the doubles game has two Foxes
    const foxVsMarth = await get("/api/replays?p1CharacterId=2&p2CharacterId=9");
    expect(foxVsMarth.body.pagination.total).toBe(2); // slots 2/3 count too
  });
});

describe("extracted stats", () => {
  let detailDir: string;
  beforeEach(() => {
    detailDir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-detail-"));
    config.statsDetailDir = detailDir;
    clearGameDetailCache();
  });
  afterEach(async () => {
    fs.rmSync(detailDir, { recursive: true, force: true });
    config.statsDetailDir = "";
    await GameStats.deleteMany({});
  });

  async function extracted(replayId: mongoose.Types.ObjectId) {
    await GameStats.collection.insertOne({
      replayId,
      filePath: "secret/path.slp",
      contentHash: "c".repeat(64),
      extractors: { core: 2, clipper: 1 },
      shards: { core: "main-aaa", clipper: "main-aaa" },
      error: null,
      winner: 0,
      winMethod: "stocks",
      lastFrame: 7200,
      consoleNick: "Matt's Wii",
      players: [
        { playerIndex: 0, userId: "secret-uid", characterColor: 2, startStocks: 4, stocksLost: 1, kills: 4, openings: 20, damageDealt: 400, neutralWins: 12, inputsPerMinute: 300, actions: { wavedashCount: 9 } },
        { playerIndex: 1, characterColor: 0, startStocks: 4, stocksLost: 4, kills: 1, openings: 15, damageDealt: 300, neutralWins: 9, inputsPerMinute: 250 },
      ],
    });
    const write = (e: string, v: number, events: object) => {
      const file = detailFile(detailDir, e, v, "main-aaa");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ r: String(replayId), ...events }) + "\n"));
    };
    write("core", 2, { conversions: [], deaths: [[1, 900, 120, 3, 0, 17, 60]] });
    write("clipper", 1, { combos: [[0, 1, 100, 200, 0, 80, 1, [[17, 150, 12, 1]]]], edgeguards: [], phantoms: [], earlyQuitOut: null });
  }

  it("adds compact stats to search results, null for games not yet extracted", async () => {
    const players = [{ playerIndex: 0, characterId: 2 }, { playerIndex: 1, characterId: 9 }];
    const a = await Replay.create({ filePath: "/test/a.slp", fileHash: "a", stageId: 31, duration: 7200, players });
    await Replay.create({ filePath: "/test/b.slp", fileHash: "b", stageId: 8, duration: 7200, players });
    await extracted(a._id as mongoose.Types.ObjectId);

    const { body } = await get("/api/replays");
    const byId = Object.fromEntries(body.replays.map((r: any) => [r._id, r.stats]));
    expect(byId[String(a._id)]).toMatchObject({ winner: 0, winMethod: "stocks", lastFrame: 7200 });
    expect(byId[String(a._id)].players[0]).toEqual({
      playerIndex: 0, characterColor: 2, startStocks: 4, stocksLost: 1, kills: 4, openings: 20, damageDealt: 400, neutralWins: 12, inputsPerMinute: 300,
    });
    expect(Object.values(byId).filter((v) => v === null)).toHaveLength(1);
  });

  it("returns one game's summary and events, without internal fields", async () => {
    const replayId = new mongoose.Types.ObjectId();
    await extracted(replayId);
    const { status, body } = await get(`/api/replays/${replayId}/stats`);
    expect(status).toBe(200);
    expect(body.summary).toMatchObject({ winner: 0, extractors: { core: 2, clipper: 1 } });
    expect(body.summary.players[0].actions).toEqual({ wavedashCount: 9 });
    for (const hidden of ["filePath", "contentHash", "shards", "_id", "consoleNick"]) expect(body.summary).not.toHaveProperty(hidden);
    for (const p of body.summary.players) expect(p).not.toHaveProperty("userId");
    expect(body.events.core.deaths).toEqual([[1, 900, 120, 3, 0, 17, 60]]);
    expect(body.events.clipper.combos).toHaveLength(1);
  });

  it("404s for games without stats and for malformed ids", async () => {
    expect((await get(`/api/replays/${new mongoose.Types.ObjectId()}/stats`)).status).toBe(404);
    expect((await get(`/api/replays/not-an-id/stats`)).status).toBe(404);
  });
});

describe("GET /api/players/:code/profile", () => {
  afterEach(async () => {
    await PlayerStats.deleteMany({});
  });

  it("returns a profile by case-insensitive, URL-encoded code, without account identifiers", async () => {
    await PlayerStats.collection.insertMany([
      {
        connectCode: "MANG#0", games: 10, decided: 9, wins: 6, names: [{ name: "mang0", games: 8 }, { name: "old tag", games: 2 }],
        userIds: ["secret-uid"], otherCodes: ["ALT#1"], totals: { kills: 30 }, builtAt: new Date(),
        opponents: [{ connectCode: "ZAIN#0", name: "zain's old name", games: 5, decided: 5, wins: 2 }, { connectCode: "NOPR#1", name: "x", games: 1, decided: 1, wins: 1 }],
      },
      { connectCode: "ZAIN#0", games: 20, decided: 20, wins: 15, names: [{ name: "Zain", games: 19 }, { name: "zain's old name", games: 1 }], totals: {}, builtAt: new Date() },
    ]);
    const { status, body } = await get("/api/players/mang%230/profile");
    expect(status).toBe(200);
    expect(body).toMatchObject({ connectCode: "MANG#0", games: 10, wins: 6, totals: { kills: 30 } });
    expect(body).not.toHaveProperty("userIds");
    expect(body).not.toHaveProperty("otherCodes");
    expect(body.names).toEqual([{ name: "mang0", games: 8 }]);
    expect(body.opponents.map((o: any) => [o.connectCode, o.name])).toEqual([["ZAIN#0", "Zain"], ["NOPR#1", null]]);
  });

  it("lists the most active players by primary name only", async () => {
    await PlayerStats.collection.insertMany([
      { connectCode: "A#1", games: 5, decided: 4, wins: 2, names: [{ name: "A", games: 4 }, { name: "old A", games: 1 }], characters: [{ characterId: 2, games: 5 }], userIds: ["u"], totals: {}, builtAt: new Date() },
      { connectCode: "B#2", games: 50, decided: 40, wins: 30, names: [{ name: "B", games: 50 }], characters: [], totals: {}, builtAt: new Date() },
    ]);
    const { status, body } = await get("/api/players/top?limit=10");
    expect(status).toBe(200);
    expect(body.map((p: any) => p.connectCode)).toEqual(["B#2", "A#1"]);
    expect(body[1]).toEqual({ connectCode: "A#1", name: "A", games: 5, decided: 4, wins: 2, mainCharacterId: 2, lastPlayed: null });
  });

  it("404s for unknown and malformed codes", async () => {
    expect((await get("/api/players/NOPE%231/profile")).status).toBe(404);
    expect((await get("/api/players/not-a-code/profile")).status).toBe(404);
  });
});

describe("tournaments and sets", () => {
  afterEach(async () => {
    await Tournament.deleteMany({});
    await TournamentSet.deleteMany({});
  });

  async function seed() {
    const now = new Date();
    await Tournament.collection.insertMany([
      { _id: "kotj-7", name: "KOTJ #7", listed: true, games: 20, sets: 2, lastAt: new Date("2026-09-22"), players: [], characters: [], stages: [], builtAt: now } as any,
      { _id: "midlane-melee-177", name: "Midlane Melee 177", listed: true, games: 90, sets: 30, lastAt: new Date("2025-06-05"), players: [], characters: [], stages: [], builtAt: now } as any,
      { _id: "friendlies", name: "Friendlies", listed: false, games: 5, sets: 0, lastAt: null, players: [], characters: [], stages: [], builtAt: now } as any,
    ]);
    await TournamentSet.collection.insertOne({
      _id: "dir-0123456789abcdef0123", source: "jungle", tournamentKey: "kotj-7", tournament: { key: "kotj-7", name: "KOTJ #7", listed: true },
      round: "Grand Finals", players: [{ name: "Goober" }, { name: "OBZDN" }], winner: 1, games: [], dir: "tournament/King of the Jungle/kotj_7/24-grand-finals", builtAt: now,
    } as any);
  }

  it("lists listed tournaments, newest first, with search", async () => {
    await seed();
    const { body } = await get("/api/tournaments");
    expect(body.tournaments.map((t: any) => t._id)).toEqual(["kotj-7", "midlane-melee-177"]);
    expect((await get("/api/tournaments?q=midlane")).body.tournaments.map((t: any) => t._id)).toEqual(["midlane-melee-177"]);
    // Word-by-word, punctuation-blind, whole numbers.
    expect((await get("/api/tournaments?q=kotj%207")).body.tournaments.map((t: any) => t._id)).toEqual(["kotj-7"]);
    expect((await get("/api/tournaments?q=melee%2017")).body.tournaments).toHaveLength(0);
    expect((await get("/api/tournaments?sort=games")).body.tournaments[0]._id).toBe("midlane-melee-177");
  });

  it("returns a tournament with its sets, never the archive folder", async () => {
    await seed();
    const { status, body } = await get("/api/tournaments/kotj-7");
    expect(status).toBe(200);
    expect(body.tournament.name).toBe("KOTJ #7");
    expect(body.sets).toHaveLength(1);
    expect(body.sets[0]).toMatchObject({ round: "Grand Finals", winner: 1 });
    expect(body.sets[0]).not.toHaveProperty("dir");
    const set = await get("/api/sets/dir-0123456789abcdef0123");
    expect(set.status).toBe(200);
    expect(set.body).not.toHaveProperty("dir");
    expect((await get("/api/tournaments/nope")).status).toBe(404);
    expect((await get("/api/tournaments/friendlies")).status).toBe(404);
    expect((await get("/api/sets/not-a-set")).status).toBe(404);
  });

  it("filters replay search to one tournament", async () => {
    const players = [{ playerIndex: 0, characterId: 2 }, { playerIndex: 1, characterId: 9 }];
    await Replay.create({ filePath: "/t/a.slp", fileHash: "a", stageId: 31, duration: 7200, players, tournamentKey: "kotj-7" });
    await Replay.create({ filePath: "/t/b.slp", fileHash: "b", stageId: 31, duration: 7200, players, tournamentKey: "other" });
    const { body } = await get("/api/replays?tournament=kotj-7");
    expect(body.replays).toHaveLength(1);
    expect(body.pagination.total).toBe(1);
    // Estimate (and so job creation) selects the same games.
    const est = await post("/api/replays/estimate", { tournament: "kotj-7" });
    expect(est.status).toBe(200);
    expect(est.body.replayCount).toBe(1);
  });
});

describe("GET /api/replays/:id", () => {
  it("returns a replay by id without its server path or folder label", async () => {
    const replay = await Replay.create({ filePath: "/test/x.slp", fileHash: "x", folderLabel: "netplay/Someone Realname/2023" });

    const { status, body } = await get(`/api/replays/${replay._id}`);
    expect(status).toBe(200);
    expect(body.filePath).toBeUndefined();
    expect(body.folderLabel).toBeUndefined();
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
    expect(body.code).toBe("filter_required");
  });

  it("rejects when no replays match", async () => {
    const { status, body } = await post("/api/jobs", { p1ConnectCode: "NOBODY#0" }, jobHeaders);
    expect(status).toBe(400);
    expect(body.error).toMatch(/no replays/i);
    expect(body.code).toBe("no_matches");
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

describe("POST /api/clips", () => {
  const clips = () => mongoose.connection.collection("clips");
  afterEach(async () => {
    await clips().deleteMany({});
  });
  const clip = (over: Record<string, unknown>) => ({
    replayId: new mongoose.Types.ObjectId(), type: "combo", startFrame: 100, endFrame: 200, gameFrames: 9000, stageId: 31,
    source: "netplay", startAt: new Date("2025-01-01"), startPercent: 0, endPercent: 80, damage: 80, moves: 5, didKill: true,
    moveList: [[1, 100, 10, 1]], score: null, rank: 80, metrics: null,
    attacker: { port: 0, characterId: 2, connectCode: "AAA#1", displayName: "Aa" },
    victim: { port: 1, characterId: 9, connectCode: "BBB#2", displayName: "Bb" },
    detail: { run: "main", extractor: "clipper", version: 1, shard: "s" },
    ...over,
  });

  it("finds Fox kill combos on Marth, best first, with what a result row needs", async () => {
    await clips().insertMany([
      clip({ rank: 80 }),
      clip({ rank: 120, damage: 120 }),
      clip({ rank: 200, attacker: { port: 0, characterId: 20, connectCode: "CCC#3", displayName: "Cc" } }), // Falco: excluded
      clip({ type: "edgeguard", rank: 50 }), // other type: excluded
    ]);
    const { status, body } = await post("/api/clips", { type: "combo", attackerCharacterId: "2", victimCharacterId: "9", killOnly: true, sort: "best" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 2, capped: false, page: 1 });
    expect(body.results.map((c: any) => c.rank)).toEqual([120, 80]);
    expect(body.results[0]).toMatchObject({ type: "combo", startFrame: 100, endFrame: 200, attacker: { connectCode: "AAA#1" }, moveList: [[1, 100, 10, 1]] });
    expect(body.results[0].id).toBeDefined();
    expect(body.results[0]).not.toHaveProperty("detail");
  });

  it("rejects a search without a valid type", async () => {
    const { status, body } = await post("/api/clips", { attackerCharacterId: "2" });
    expect(status).toBe(400);
    expect(body.code).toBe("invalid_request");
  });
});

describe("count cap", () => {
  it("stops counting at countCap and says so, in search and estimate", async () => {
    const { config } = await import("../config");
    const saved = config.countCap;
    config.countCap = 3;
    try {
      for (let i = 0; i < 5; i++) {
        await Replay.create({ filePath: `/test/cap${i}.slp`, fileHash: `cap${i}`, fileSize: 1000, stageId: 31, players: [{ playerIndex: 0, characterId: 2 }] });
      }
      const list = await get("/api/replays?stageId=31&limit=2");
      expect(list.body.pagination).toMatchObject({ total: 3, totalCapped: true });
      const est = await post("/api/replays/estimate", { stageId: "31" });
      expect(est.body).toMatchObject({ replayCount: 3, rawSize: 3000, capped: true });
      const limited = await post("/api/replays/estimate", { stageId: "31", maxFiles: 2 });
      expect(limited.body).toMatchObject({ replayCount: 2, capped: false });
    } finally {
      config.countCap = saved;
    }
  });
});

describe("download queue: reuse, sharing, size cap, public queue", () => {
  const A = { "X-Client-Id": "a1a1a1a1-b1b1-c2c2-d3d3-e4e4e4e4e4e4" };
  const B = { "X-Client-Id": "b2b2b2b2-b1b1-c2c2-d3d3-e4e4e4e4e4e4" };
  const seed = () =>
    Replay.create({ filePath: "/test/q.slp", fileHash: "q", fileSize: 100000, players: [{ playerIndex: 0, connectCode: "Q#1", characterId: 2, characterName: "Fox" }] });

  it("gives a second identical request the same job and lets both follow it", async () => {
    await seed();
    const first = await post("/api/jobs", { p1ConnectCode: "Q#1", p1CharacterId: "2" }, A);
    expect(first.status).toBe(201);
    expect(first.body.lane).toBe("fast");
    // Same filter, values in another order: same bundle.
    const second = await post("/api/jobs", { p1CharacterId: "2", p1ConnectCode: "Q#1" }, B);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ jobId: first.body.jobId, reused: true });
    expect(await Job.countDocuments()).toBe(1);

    expect((await get("/api/jobs", B)).body.jobs.map((j: any) => String(j._id))).toEqual([String(first.body.jobId)]);
    const status = await get(`/api/jobs/${first.body.jobId}`, B);
    expect(status.status).toBe(200);
    expect(status.body.sharedWith).toBe(1);
  });

  it("hands a shared job to a follower when its creator cancels, and lets followers leave", async () => {
    const job = await Job.create({ filter: { p1ConnectCode: "Q#1" }, createdBy: A["X-Client-Id"], followers: [B["X-Client-Id"]] });
    expect((await del(`/api/jobs/${job._id}`, A)).status).toBe(200);
    let after = await Job.findById(job._id).lean();
    expect(after).toMatchObject({ status: "pending", createdBy: B["X-Client-Id"], followers: [] });
    expect((await del(`/api/jobs/${job._id}`, B)).status).toBe(200);
    after = await Job.findById(job._id).lean();
    expect(after!.status).toBe("cancelled");
  });

  it("reuses a finished bundle that is still in storage", async () => {
    await seed();
    const done = await Job.create({
      filter: { p1ConnectCode: "Q#1" }, filterKey: "p1ConnectCode=Q#1", status: "completed", r2Key: "jobs/q.zip", completedAt: new Date(), createdBy: A["X-Client-Id"],
    });
    const { status, body } = await post("/api/jobs", { p1ConnectCode: "Q#1" }, B);
    expect(status).toBe(200);
    expect(body).toMatchObject({ jobId: String(done._id), status: "completed", reused: true });
  });

  it("accepts bundles of any size by default, and refuses over a configured cap", async () => {
    // 200 GB raw is ~25 GB of bundle.
    await Replay.create({ filePath: "/test/big.slp", fileHash: "big", fileSize: 200 * 1024 ** 3, players: [{ playerIndex: 0, connectCode: "BIG#1", characterId: 2, characterName: "Fox" }] });
    const est = await post("/api/replays/estimate", { p1ConnectCode: "BIG#1" }, A);
    expect(est.body.queue).toMatchObject({ tooLarge: false, lane: "main" });
    const ok = await post("/api/jobs", { p1ConnectCode: "BIG#1" }, A);
    expect(ok.status).toBe(201);
    await Job.deleteMany({});

    const { config } = await import("../config");
    const saved = config.jobMaxBundleMb;
    config.jobMaxBundleMb = 20480;
    try {
      const { status, body } = await post("/api/jobs", { p1ConnectCode: "BIG#1" }, B);
      expect(status).toBe(400);
      expect(body.code).toBe("too_large");
      expect(body.maxBytes).toBe(20480 * 1024 * 1024);
    } finally {
      config.jobMaxBundleMb = saved;
    }
  });

  it("forecasts a new download in the estimate and points at an identical one", async () => {
    await seed();
    const est = await post("/api/replays/estimate", { p1ConnectCode: "Q#1" }, A);
    expect(est.body.queue).toMatchObject({ reusable: null, tooLarge: false, lane: "fast", ahead: 0, paused: null });
    const job = await post("/api/jobs", { p1ConnectCode: "Q#1" }, A);
    const again = await post("/api/replays/estimate", { p1ConnectCode: "Q#1" }, B);
    expect(again.body.queue.reusable).toEqual({ jobId: String(job.body.jobId), status: "pending" });
  });

  it("publishes the queue without saying who asked, marking only the caller's jobs", async () => {
    await Job.create({ filter: { p1ConnectCode: "Q#1" }, createdBy: A["X-Client-Id"], estimatedSize: 8_000_000, status: "bundling" });
    await Job.create({ filter: { stageId: "31" }, createdBy: B["X-Client-Id"], estimatedSize: 8_000_000 });
    await Job.create({ filter: { stageId: "32" }, createdBy: A["X-Client-Id"], status: "completed", r2Key: "jobs/r.zip", bundleSize: 5, completedAt: new Date() });
    const { status, body } = await get("/api/jobs/queue", B);
    expect(status).toBe(200);
    expect(body.running).toHaveLength(1);
    expect(body.waiting).toHaveLength(1);
    expect(body.waiting[0]).toMatchObject({ position: 1, mine: true, filter: { stageId: "31" } });
    expect(body.running[0].mine).toBe(false);
    expect(body.recent).toHaveLength(1);
    expect(body.recent[0].expiresAt).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/createdBy|followers|a1a1a1a1|b2b2b2b2/);
  });

  it("lets anyone download a finished bundle", async () => {
    const job = await Job.create({ filter: { p1ConnectCode: "Q#1" }, status: "completed", r2Key: "jobs/q.zip", createdBy: A["X-Client-Id"] });
    const { body } = await get(`/api/jobs/${job._id}/download`, B);
    expect(body.code).not.toBe("forbidden");
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

describe("DELETE /api/jobs/:id — codes and races", () => {
  it("cancels an active job", async () => {
    const job = await Job.create({ filter: { p1ConnectCode: "X#1" }, status: "uploading", createdBy: TEST_CLIENT_ID });
    const { status } = await del(`/api/jobs/${job._id}`, { "X-Client-Id": TEST_CLIENT_ID });
    expect(status).toBe(200);
    expect((await Job.findById(job._id))!.status).toBe("cancelled");
  });

  it("never overwrites a job that already completed", async () => {
    const job = await Job.create({
      filter: { p1ConnectCode: "X#1" }, status: "completed", r2Key: "jobs/x.zip", createdBy: TEST_CLIENT_ID,
    });
    const { status, body } = await del(`/api/jobs/${job._id}`, { "X-Client-Id": TEST_CLIENT_ID });
    expect(status).toBe(400);
    expect(body.code).toBe("cannot_cancel");
    const after = await Job.findById(job._id);
    expect(after!.status).toBe("completed");
    expect(after!.r2Key).toBe("jobs/x.zip");
  });

  it("reports another client's job as forbidden and a missing one as not found", async () => {
    const job = await Job.create({ filter: { p1ConnectCode: "X#1" }, status: "pending", createdBy: "someone-else" });
    const forbidden = await del(`/api/jobs/${job._id}`, { "X-Client-Id": TEST_CLIENT_ID });
    expect(forbidden.body.code).toBe("forbidden");
    expect((await Job.findById(job._id))!.status).toBe("pending");

    const missing = await del(`/api/jobs/${new mongoose.Types.ObjectId()}`, { "X-Client-Id": TEST_CLIENT_ID });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("not_found");
  });
});

describe("GET /api/jobs/:id", () => {
  it("returns job status with downloadReady flag", async () => {
    const job = await Job.create({ filter: { p1ConnectCode: "X#1" }, createdBy: TEST_CLIENT_ID });

    const { status, body } = await get(`/api/jobs/${job._id}`, { "X-Client-Id": TEST_CLIENT_ID });
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
      r2Key: "jobs/test.zip",
      createdBy: TEST_CLIENT_ID,
    });

    const { body } = await get(`/api/jobs/${job._id}`, { "X-Client-Id": TEST_CLIENT_ID });
    expect(body.downloadReady).toBe(true);
  });

  it("returns queuePosition and ETAs for pending jobs", async () => {
    // Explicit, distinct createdAt so queue ordering is deterministic — created
    // back-to-back these can share a millisecond and tie the "jobs ahead" count.
    // No finished jobs to measure, so the rate is ESTIMATE_UPLOAD_SPEED_MBPS
    // (default 10 Mbps = 1.25 MB/s): 75 MB of bundle (600 MB raw) = 60 s.
    const job1 = await Job.create({ filter: { p1ConnectCode: "X#1" }, estimatedSize: 600_000_000, createdBy: TEST_CLIENT_ID, createdAt: new Date("2026-01-01T00:00:00.000Z") });
    const job2 = await Job.create({ filter: { p1ConnectCode: "Y#1" }, estimatedSize: 300_000_000, createdBy: TEST_CLIENT_ID, createdAt: new Date("2026-01-01T00:00:01.000Z") });

    // job1 is first (created earlier), job2 is second
    const { body: body1 } = await get(`/api/jobs/${job1._id}`, { "X-Client-Id": TEST_CLIENT_ID });
    expect(body1.queuePosition).toBe(1);
    expect(body1.estimatedWaitSec).toBe(0); // nothing ahead
    expect(body1.estimatedProcessingTimeSec).toBe(60);

    const { body: body2 } = await get(`/api/jobs/${job2._id}`, { "X-Client-Id": TEST_CLIENT_ID });
    expect(body2.queuePosition).toBe(2);
    expect(body2.estimatedWaitSec).toBe(60); // job1 ahead
    expect(body2.estimatedProcessingTimeSec).toBe(30);
  });

  it("returns queuePosition 0 for active job", async () => {
    // 125 MB of bundle = 100 s at 1.25 MB/s. Bundling is the first half of the
    // work, so half the files bundled = a quarter done: 75 s left.
    const job = await Job.create({
      filter: { p1ConnectCode: "X#1" },
      status: "bundling",
      estimatedSize: 1_000_000_000,
      progress: { step: "bundling", filesProcessed: 50, filesTotal: 100 },
      createdBy: TEST_CLIENT_ID,
    });

    const { body } = await get(`/api/jobs/${job._id}`, { "X-Client-Id": TEST_CLIENT_ID });
    expect(body.queuePosition).toBe(0);
    expect(body.estimatedWaitSec).toBe(0);
    expect(body.estimatedProcessingTimeSec).toBe(75);
  });

  it("returns queuePosition 0 for bundled job", async () => {
    const job = await Job.create({
      filter: { p1ConnectCode: "X#1" },
      status: "bundled",
      estimatedProcessingTime: 60,
      createdBy: TEST_CLIENT_ID,
    });

    const { body } = await get(`/api/jobs/${job._id}`, { "X-Client-Id": TEST_CLIENT_ID });
    expect(body.queuePosition).toBe(0);
    expect(body.estimatedWaitSec).toBe(0);
  });

  it("returns null queue fields for terminal statuses", async () => {
    const job = await Job.create({ filter: { p1ConnectCode: "X#1" }, status: "completed", r2Key: "jobs/test.zip", createdBy: TEST_CLIENT_ID });

    const { body } = await get(`/api/jobs/${job._id}`, { "X-Client-Id": TEST_CLIENT_ID });
    expect(body.queuePosition).toBeNull();
    expect(body.estimatedWaitSec).toBeNull();
    expect(body.estimatedProcessingTimeSec).toBeNull();
  });

  it("priority affects queue ordering", async () => {
    // Create job1 first but with higher priority number (lower priority)
    // Sizes as in the ETA test above: 600 MB raw = 60 s, 300 MB raw = 30 s.
    const job1 = await Job.create({ filter: { p1ConnectCode: "X#1" }, priority: 5, estimatedSize: 600_000_000, createdBy: TEST_CLIENT_ID });
    const job2 = await Job.create({ filter: { p1ConnectCode: "Y#1" }, priority: 0, estimatedSize: 300_000_000, createdBy: TEST_CLIENT_ID });

    // job2 has lower priority number = processed first
    const { body: body2 } = await get(`/api/jobs/${job2._id}`, { "X-Client-Id": TEST_CLIENT_ID });
    expect(body2.queuePosition).toBe(1);

    const { body: body1 } = await get(`/api/jobs/${job1._id}`, { "X-Client-Id": TEST_CLIENT_ID });
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
      createdBy: TEST_CLIENT_ID,
    });

    const res = await fetch(`${baseUrl}/api/jobs/${job._id}/download`, {
      redirect: "manual",
      headers: { "X-Client-Id": TEST_CLIENT_ID },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("not_ready");
  });
});

describe("GET /api/jobs/:id/download — full-DB throttle", () => {
  async function fullDbJob() {
    return Job.create({
      filter: {}, status: "completed", r2Key: "archive/lunar_db_full.zip",
      pinned: true, isFullDb: true, bundleSize: 1_000_000_000_000,
      replayCount: 1000, completedAt: new Date(),
    });
  }
  // Downloads can't complete in tests (no S3 creds) — they 500 at presign. The
  // throttle runs BEFORE that, so a blocked pull is a clean 429 and an allowed
  // pull is simply "not 429".

  it("429s a client that already hit the cap (default 2/window)", async () => {
    const job = await fullDbJob();
    await seedFullDbEvent(TEST_CLIENT_ID);
    await seedFullDbEvent(TEST_CLIENT_ID);

    const res = await fetch(`${baseUrl}/api/jobs/${job._id}/download`, {
      redirect: "manual", headers: { "X-Client-Id": TEST_CLIENT_ID },
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.code).toBe("fulldb_rate_limited");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("allows a client still under the cap", async () => {
    const job = await fullDbJob();
    await seedFullDbEvent(TEST_CLIENT_ID); // 1 < 2

    const res = await fetch(`${baseUrl}/api/jobs/${job._id}/download`, {
      redirect: "manual", headers: { "X-Client-Id": TEST_CLIENT_ID },
    });
    expect(res.status).not.toBe(429);
  });

  it("ignores pulls older than the window", async () => {
    const job = await fullDbJob();
    const stale = (config.fullDbWindowHours + 1) * 3600 * 1000;
    await seedFullDbEvent(TEST_CLIENT_ID, stale);
    await seedFullDbEvent(TEST_CLIENT_ID, stale);

    const res = await fetch(`${baseUrl}/api/jobs/${job._id}/download`, {
      redirect: "manual", headers: { "X-Client-Id": TEST_CLIENT_ID },
    });
    expect(res.status).not.toBe(429);
  });

  it("does not throttle normal (non-full-DB) bundles", async () => {
    const job = await Job.create({
      filter: { p1ConnectCode: "Z#1" }, status: "completed", r2Key: "jobs/z.zip",
      createdBy: TEST_CLIENT_ID, isFullDb: false, bundleSize: 5000, completedAt: new Date(),
    });
    // Even with full-DB pulls over the cap, a normal bundle download is untouched.
    await seedFullDbEvent(TEST_CLIENT_ID);
    await seedFullDbEvent(TEST_CLIENT_ID);
    await seedFullDbEvent(TEST_CLIENT_ID);

    const res = await fetch(`${baseUrl}/api/jobs/${job._id}/download`, {
      redirect: "manual", headers: { "X-Client-Id": TEST_CLIENT_ID },
    });
    expect(res.status).not.toBe(429);
  });
});

describe("GET /api/jobs/bundles", () => {
  it("returns completed jobs sorted by downloadCount", async () => {
    await Job.create({
      filter: { p1ConnectCode: "A#1" }, status: "completed", r2Key: "archive/a.zip",
      pinned: true, replayCount: 10, bundleSize: 5000, downloadCount: 5, completedAt: new Date(),
    });
    await Job.create({
      filter: { p1ConnectCode: "B#1" }, status: "completed", r2Key: "archive/b.zip",
      pinned: true, replayCount: 20, bundleSize: 10000, downloadCount: 15, completedAt: new Date(),
    });
    // unpinned completed bundle must NOT appear in the public catalog
    await Job.create({
      filter: { p1ConnectCode: "D#1" }, status: "completed", r2Key: "jobs/d.zip",
      pinned: false, replayCount: 1, bundleSize: 100, downloadCount: 99, completedAt: new Date(),
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
        filter: { p1ConnectCode: `P${i}#1` }, status: "completed", r2Key: `archive/p${i}.zip`,
        pinned: true, replayCount: 10, bundleSize: 5000, downloadCount: i, completedAt: new Date(),
      });
    }

    const { body } = await get("/api/jobs/bundles?limit=2&page=1");
    expect(body.bundles.length).toBe(2);
    expect(body.pagination.pages).toBe(2);
  });

  it("lists the full-DB bundle first with its snapshot date", async () => {
    await Job.create({
      filter: { p1ConnectCode: "A#1" }, status: "completed", r2Key: "archive/a.zip",
      pinned: true, replayCount: 10, bundleSize: 5000, downloadCount: 50, completedAt: new Date(),
    });
    await Job.create({
      filter: {}, status: "completed", r2Key: "archive/lunar_db_full.zip", pinned: true, isFullDb: true,
      replayCount: 3000, bundleSize: 9_000_000, downloadCount: 1, completedAt: new Date(),
      snapshotAt: new Date("2026-09-26T17:00:00Z"),
    });

    const { body } = await get("/api/jobs/bundles");
    expect(body.bundles[0]).toMatchObject({
      fullDb: true, replayCount: 3000, bundleSize: 9_000_000, snapshotAt: "2026-09-26T17:00:00.000Z",
    });
    expect(body.bundles[0]).not.toHaveProperty("isFullDb");
  });
});

describe("GET /api/jobs/:id/download — download count", () => {
  it("increments downloadCount on each download", async () => {
    const job = await Job.create({
      filter: { p1ConnectCode: "X#1" }, status: "completed",
      r2Key: "jobs/test.zip", downloadCount: 0, createdBy: TEST_CLIENT_ID,
    });

    // The download will fail since R2 is not configured in tests,
    // but the increment happens before the presigned URL generation,
    // so we verify by checking the DB after the attempt
    await fetch(`${baseUrl}/api/jobs/${job._id}/download`, {
      redirect: "manual",
      headers: { "X-Client-Id": TEST_CLIENT_ID },
    });

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
  beforeEach(() => clearStatsCache());

  it("returns replay count and job counts", async () => {
    await Replay.create({ filePath: "/test/s.slp", fileHash: "s", stageId: 31, players: [{ playerIndex: 0, connectCode: "S#1", characterId: 2, characterName: "Fox" }] });
    await Job.create({ filter: {} });

    const { status, body } = await get("/api/stats");
    expect(status).toBe(200);
    expect(body.replays).toBe(1);
    expect(body.jobs).toBeDefined();
  });

  it("serves replay totals from a short cache but keeps job counts live", async () => {
    await Replay.create({ filePath: "/test/c1.slp", fileHash: "c1", stageId: 31, players: [{ playerIndex: 0, connectCode: "C#1", characterId: 2, characterName: "Fox" }] });
    const first = await get("/api/stats");
    expect(first.body.replays).toBe(1);

    await Replay.create({ filePath: "/test/c2.slp", fileHash: "c2", stageId: 31, players: [{ playerIndex: 0, connectCode: "C#2", characterId: 2, characterName: "Fox" }] });
    await Job.create({ filter: {}, status: "pending" });
    const second = await get("/api/stats");
    expect(second.body.replays).toBe(1); // cached
    expect(second.body.jobs.pending).toBe(1); // live

    clearStatsCache();
    expect((await get("/api/stats")).body.replays).toBe(2);
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

describe("GET /api/players/autocomplete — collection aliases", () => {
  beforeEach(async () => {
    await Player.deleteMany({});
    await Player.create([
      { connectCode: "TX#490", displayName: "TX-5532", aliases: ["Eikelmann"], gameCount: 1966 },
      { connectCode: "EIK#1", displayName: "Eiko", gameCount: 3 },
      { connectCode: "PGP#827", displayName: "PGP", aliases: [], gameCount: 7321 },
    ]);
  });
  afterEach(() => Player.deleteMany({}));

  it("finds a player by their collection folder name as well as code and display name", async () => {
    const byAlias = await get("/api/players/autocomplete?q=eik");
    expect(byAlias.body.map((p: any) => p.connectCode)).toEqual(["TX#490", "EIK#1"]);
    expect(byAlias.body[0].aliases).toEqual(["Eikelmann"]);

    expect((await get("/api/players/autocomplete?q=tx")).body[0].connectCode).toBe("TX#490");
    expect((await get("/api/players/search?q=eikel")).body.map((p: any) => p.connectCode)).toEqual(["TX#490"]);
  });
});
