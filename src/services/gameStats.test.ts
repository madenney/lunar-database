import path from "path";
import { decideWinner, extractGameStats, matchMode, RESULT_POLICY, STATS_VERSION } from "./gameStats";

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

describe("extractGameStats", () => {
  const { summary, events } = extractGameStats(path.join(__dirname, "../__fixtures__/test.slp"));
  const { conversions, combos, deaths, edgeguards, phantoms } = events;

  it("summarises the game and keys players by port index", () => {
    expect(summary.version).toBe(STATS_VERSION);
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
    expect(summary.detectorErrors).toEqual([]);
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
});
