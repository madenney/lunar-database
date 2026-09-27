import path from "path";
import {
  decideWinner,
  extractGame,
  gameFingerprint,
  statsWithoutActions,
  matchMode,
  EXTRACTORS,
  EXTRACTOR_NAMES,
  RESULT_POLICY,
  type ComboRow,
  type ConversionRow,
  type CoreSummary,
  type DeathRow,
  type EdgeguardRow,
  type PhantomRow,
  type TechLedgeRow,
} from "./gameStats";
import { readMatchInfo } from "./matchInfo";

const P = (playerIndex: number, startStocks = 4) => ({ playerIndex, startStocks });
const died = (playerIndex: number, n: number) =>
  Array.from({ length: n }, () => ({ playerIndex, endFrame: 100, currentPercent: 0 }));
const alive = (playerIndex: number, currentPercent: number) => ({ playerIndex, endFrame: null, currentPercent });
const base = { lastFrame: 10000, endMethod: 2, lrasInitiator: -1 };

describe("decideWinner", () => {
  it("awards the game to the player with stocks left", () => {
    const r = decideWinner({ ...base, players: [P(0), P(3)], stocks: [...died(3, 4), ...died(0, 2), alive(0, 40)] });
    expect(r).toEqual({ winner: 0, winMethod: "stocks" });
  });

  it("uses stocks, then percent, on timeout", () => {
    const time = { ...base, endMethod: 1 };
    expect(decideWinner({ ...time, players: [P(0), P(1)], stocks: [...died(0, 1), alive(0, 10), alive(1, 90)] }))
      .toEqual({ winner: 1, winMethod: "time" });
    expect(decideWinner({ ...time, players: [P(0), P(1)], stocks: [alive(0, 10), alive(1, 90)] }))
      .toEqual({ winner: 0, winMethod: "time" });
    expect(decideWinner({ ...time, players: [P(0), P(1)], stocks: [alive(0, 50), alive(1, 50)] }))
      .toEqual({ winner: null, winMethod: null });
  });

  it("treats a quit-out as a forfeit, but not a quick restart or a quitter who was ahead", () => {
    const lras = { ...base, endMethod: 7, lrasInitiator: 1 };
    expect(decideWinner({ ...lras, players: [P(0), P(1)], stocks: [...died(1, 2), alive(0, 20), alive(1, 20)] }))
      .toEqual({ winner: 0, winMethod: "lras" });
    expect(decideWinner({ ...lras, lastFrame: 600, players: [P(0), P(1)], stocks: [alive(0, 0), alive(1, 0)] }))
      .toEqual({ winner: null, winMethod: null });
    expect(decideWinner({ ...lras, players: [P(0), P(1)], stocks: [...died(0, 3), alive(0, 50), alive(1, 20)] }))
      .toEqual({ winner: null, winMethod: null });
  });

  it("leaves truncated games and non-1v1 games undecided", () => {
    expect(decideWinner({ ...base, endMethod: null, players: [P(0), P(1)], stocks: [alive(0, 30), alive(1, 30)] }))
      .toEqual({ winner: null, winMethod: null });
    expect(decideWinner({ ...base, players: [P(0), P(1), P(2)], stocks: [...died(1, 4)] }))
      .toEqual({ winner: null, winMethod: null });
  });
});

describe("matchMode", () => {
  it("reads the mode from an online match ID", () => {
    expect(matchMode("mode.ranked-2024-06-17T01:23:45.67-0")).toBe("ranked");
    expect(matchMode("mode.direct-2023-01-01T00:00:00.00-0")).toBe("direct");
    expect(matchMode(null)).toBeNull();
    expect(matchMode("")).toBeNull();
  });
});

describe("extractGame", () => {
  const FIXTURE = path.join(__dirname, "../__fixtures__/test.slp");
  const x = extractGame(FIXTURE);
  const summary = x.fields as unknown as CoreSummary;
  const { conversions, deaths } = x.events.core as { conversions: ConversionRow[]; deaths: DeathRow[] };
  const { combos, edgeguards, phantoms } = x.events.clipper as {
    combos: ComboRow[];
    edgeguards: EdgeguardRow[];
    phantoms: PhantomRow[];
  };

  it("runs every extractor by default and records their versions", () => {
    expect(x.versions).toEqual(EXTRACTORS);
    expect(x.errors).toEqual({});
  });

  it("runs only the extractors asked for, and only their fields", () => {
    const only = extractGame(FIXTURE, ["identity"]);
    expect(only.versions).toEqual({ identity: EXTRACTORS.identity });
    expect(Object.keys(only.fields).sort()).toEqual(["contentHash", "fingerprint", "gecko"]);
    expect(only.fields.contentHash).toBe(x.fields.contentHash);
    expect(only.events).toEqual({});
  });

  it("summarises the game and keys players by port index", () => {
    expect(summary.resultPolicy).toBe(RESULT_POLICY);
    expect(summary.players.map((p) => p.playerIndex)).toEqual([0, 3]);
    expect(summary.winner === 0 || summary.winner === 3).toBe(true);
    expect(summary.winMethod).toBe("stocks");
    for (const p of summary.players) {
      expect(p.openings).toBeGreaterThan(0);
      expect(p.actions).toHaveProperty("lCancelCount");
      expect(p.actions).not.toHaveProperty("playerIndex");
      expect(p).toHaveProperty("userId");
    }
    const loser = summary.players.find((p) => p.playerIndex !== summary.winner)!;
    expect(loser.stocksLost).toBe(loser.startStocks);
  });

  it("records match, rules and platform context, null when the file lacks it", () => {
    expect(Object.keys(summary.match).sort()).toEqual(["gameNumber", "id", "mode", "tiebreaker"]);
    expect(summary.match.mode).toBe(matchMode(summary.match.id));
    expect(summary.rules).toHaveProperty("startingTimerSeconds");
    expect(summary.rollbackFrames).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(summary.placements)).toBe(true);
  });

  it("emits conversion rows with their moves", () => {
    expect(conversions.length).toBeGreaterThan(0);
    for (const c of conversions) {
      expect(c).toHaveLength(10);
      expect([0, 3]).toContain(c[1]);
      expect(c[9]).toHaveLength(c[6]);
    }
    const kills = conversions.filter((c) => c[7] === 1).length;
    expect(kills).toBe(summary.players.reduce((n, p) => n + p.kills, 0));
  });

  it("records every lost stock, with the killer and kill move when a conversion took it", () => {
    const lost = summary.players.reduce((n, p) => n + p.stocksLost, 0);
    expect(deaths).toHaveLength(lost);
    for (const [victim, frame, , direction, killer, move] of deaths) {
      expect([0, 3]).toContain(victim);
      expect(frame).toBeGreaterThan(0);
      if (direction != null) expect([0, 1, 2, 3]).toContain(direction);
      if (killer != null) {
        expect(killer).not.toBe(victim);
        expect(typeof move).toBe("number");
      }
    }
    expect(deaths.some((d) => d[4] != null)).toBe(true);
  });

  it("runs Clipper's detectors on 1v1 games", () => {
    expect(combos.length).toBeGreaterThan(0);
    for (const [comboer, comboee, start, end, , , didKill, moves] of combos) {
      expect(comboer).not.toBe(comboee);
      expect(end).toBeGreaterThanOrEqual(start);
      expect([0, 1]).toContain(didKill);
      expect(moves.length).toBeGreaterThan(0);
    }
    for (const [victim, edgeguarder, , , metrics] of edgeguards) {
      expect(victim).not.toBe(edgeguarder);
      expect(metrics).toHaveProperty("score");
    }
    expect(Array.isArray(phantoms)).toBe(true);
  });

  it("identifies the recording and the played game", () => {
    expect(x.fields.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(x.fields.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(x.fields.gecko).toEqual(expect.objectContaining({ count: expect.any(Number) }));
  });

  it("measures where each player spends the game", () => {
    const pos = x.fields.position as { players: { playerIndex: number; activeFrames: number; center: number | null }[]; avgDistance: number | null };
    expect(pos.players.map((p) => p.playerIndex)).toEqual([0, 3]);
    for (const p of pos.players) {
      expect(p.activeFrames).toBeGreaterThan(0);
      expect(p.activeFrames).toBeLessThanOrEqual(summary.lastFrame + 1);
    }
    expect(pos.avgDistance).toBeGreaterThan(0);
  });

  it("records tech, getup and ledge options with per-player counts", () => {
    const { options } = x.events.techLedge as { options: TechLedgeRow[] };
    const counts = x.fields.techLedge as Record<string, Record<string, number>>;
    const total = Object.values(counts).reduce((n, c) => n + Object.values(c).reduce((a, b) => a + b, 0), 0);
    expect(total).toBe(options.length);
    for (const [player, , kind, , direction] of options) {
      expect([0, 3]).toContain(player);
      expect(["tech", "getup", "ledge"]).toContain(kind);
      expect([null, "toward", "away"]).toContain(direction);
    }
  });
});

describe("gameFingerprint", () => {
  const settings = {
    stageId: 31,
    randomSeed: 12345,
    matchInfo: { sessionId: "mode.unranked-x", gameNumber: 2 },
    players: [
      { port: 2, characterId: 20, characterColor: 0, connectCode: "B#2", startStocks: 4 },
      { port: 1, characterId: 2, characterColor: 1, connectCode: "A#1", startStocks: 4 },
    ],
  };

  it("is the same for any recording of the game, whatever order players are listed", () => {
    expect(gameFingerprint(settings)).toBe(gameFingerprint({ ...settings, players: [...settings.players].reverse() }));
  });

  it("differs for a different game", () => {
    expect(gameFingerprint({ ...settings, randomSeed: 999 })).not.toBe(gameFingerprint(settings));
    expect(gameFingerprint({ ...settings, matchInfo: { ...settings.matchInfo, gameNumber: 3 } })).not.toBe(gameFingerprint(settings));
  });
});

describe("readMatchInfo", () => {
  it("prefers sessionId, falls back to the deprecated matchId, and nulls missing fields", () => {
    expect(readMatchInfo({ sessionId: "mode.ranked-x", matchId: "mode.old-y", gameNumber: 2, tiebreakerNumber: 0 })).toEqual({
      id: "mode.ranked-x",
      mode: "ranked",
      gameNumber: 2,
      tiebreaker: 0,
    });
    expect(readMatchInfo({ matchId: "mode.unranked-y" })).toMatchObject({ id: "mode.unranked-y", mode: "unranked" });
    expect(readMatchInfo(undefined)).toEqual({ id: null, mode: null, gameNumber: null, tiebreaker: null });
  });
});

describe("statsWithoutActions", () => {
  it("matches slippi-js getStats apart from action counts", () => {
    const { SlippiGame } = jest.requireActual("@slippi/slippi-js/node");
    const file = path.join(__dirname, "../__fixtures__/test.slp");
    const full = new SlippiGame(file).getStats();
    const fallback = statsWithoutActions(new SlippiGame(file));
    const { actionCounts, ...rest } = full;
    const { actionCounts: none, ...fallbackRest } = fallback;
    expect(none).toEqual([]);
    expect(actionCounts.length).toBeGreaterThan(0);
    expect(fallbackRest).toEqual(rest);
  });
});
