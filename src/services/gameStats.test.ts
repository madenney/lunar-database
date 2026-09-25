import path from "path";
import { decideWinner, extractGameStats, STATS_VERSION } from "./gameStats";

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

describe("extractGameStats", () => {
  const { summary, conversions } = extractGameStats(path.join(__dirname, "../__fixtures__/test.slp"));

  it("summarises the game and keys players by port index", () => {
    expect(summary.version).toBe(STATS_VERSION);
    expect(summary.players.map((p) => p.playerIndex)).toEqual([0, 3]);
    expect(summary.winner === 0 || summary.winner === 3).toBe(true);
    expect(summary.winMethod).toBe("stocks");
    for (const p of summary.players) {
      expect(p.openings).toBeGreaterThan(0);
      expect(p.actions).toHaveProperty("lCancelCount");
      expect(p.actions).not.toHaveProperty("playerIndex");
    }
    const loser = summary.players.find((p) => p.playerIndex !== summary.winner)!;
    expect(loser.stocksLost).toBe(loser.startStocks);
  });

  it("emits compact conversion rows", () => {
    expect(conversions.length).toBeGreaterThan(0);
    for (const c of conversions) {
      expect(c).toHaveLength(9);
      expect([0, 3]).toContain(c[1]);
    }
    const kills = conversions.filter((c) => c[7] === 1).length;
    expect(kills).toBe(summary.players.reduce((n, p) => n + p.kills, 0));
  });
});
