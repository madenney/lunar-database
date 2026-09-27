import { PlayerStatsBuilder, countsForProfiles, type GameForProfile } from "./playerStats";

const game = (over: Partial<GameForProfile> & { a?: object; b?: object } = {}): GameForProfile => {
  const { a, b, ...rest } = over;
  return {
    replayId: "x",
    source: "netplay",
    startAt: new Date("2026-03-10T00:00:00Z"),
    stageId: 31,
    winner: 0,
    numPlayers: 2,
    hasCpu: false,
    players: [
      { playerIndex: 0, connectCode: "AAA#1", displayName: "Alpha", userId: "u1", characterId: 2, stocksLost: 2, kills: 4, openings: 20, damageDealt: 400, neutralWins: 12, counterHits: 3, inputsPerMinute: 300, actions: { lCancelCount: { success: 9, fail: 1 }, wavedashCount: 5 }, ...a },
      { playerIndex: 1, connectCode: "BBB#2", displayName: "Bravo", userId: "u2", characterId: 20, stocksLost: 4, kills: 2, openings: 15, damageDealt: 300, neutralWins: 8, counterHits: 1, inputsPerMinute: 250, ...b },
    ],
    position: { players: [{ playerIndex: 0, activeFrames: 100, center: 40, offstage: 10, closer: 60 }, { playerIndex: 1, activeFrames: 100, center: 20, offstage: 20, closer: 40 }] },
    techLedge: { 0: { "tech.in_place": 2 }, 1: { "ledge.drop": 3 } },
    ...rest,
  };
};

const profileOf = (b: PlayerStatsBuilder, code: string) => [...b.profiles()].find((p) => p.connectCode === code)!;

describe("PlayerStatsBuilder", () => {
  it("counts only human 1v1 games", () => {
    expect(countsForProfiles(game())).toBe(true);
    expect(countsForProfiles(game({ hasCpu: true }))).toBe(false);
    expect(countsForProfiles(game({ numPlayers: 4 }))).toBe(false);
  });

  it("builds records, breakdowns and raw totals for both players", () => {
    const b = new PlayerStatsBuilder();
    b.add(game());
    b.add(game({ winner: 1, stageId: 8, startAt: new Date("2026-04-02T00:00:00Z") }));
    b.add(game({ winner: null }));
    const a = profileOf(b, "AAA#1");
    expect(a).toMatchObject({ games: 3, decided: 2, wins: 1, sources: { netplay: 3 } });
    expect(a.characters).toEqual([{ characterId: 2, games: 3, decided: 2, wins: 1 }]);
    expect(a.vsCharacters).toEqual([{ characterId: 20, games: 3, decided: 2, wins: 1 }]);
    expect(a.stages.map((s) => [s.stageId, s.games])).toEqual([[31, 2], [8, 1]]);
    expect(a.opponents).toEqual([{ connectCode: "BBB#2", name: "Bravo", games: 3, decided: 2, wins: 1 }]);
    expect(a.monthly.map((m) => m.month)).toEqual(["2026-03", "2026-04"]);
    expect(a.totals).toMatchObject({ kills: 12, openings: 60, neutralWins: 36, oppNeutralWins: 24, lCancelSuccess: 27, lCancelFail: 3, wavedashes: 15, positionGames: 3, closerFrames: 180, oppCloserFrames: 120 });
    expect(a.techLedge).toEqual({ "tech.in_place": 6 });
    expect(profileOf(b, "BBB#2")).toMatchObject({ games: 3, decided: 2, wins: 1, techLedge: { "ledge.drop": 9 } });
    expect(a.firstPlayed?.toISOString().slice(0, 7)).toBe("2026-03");
    expect(a.lastPlayed?.toISOString().slice(0, 7)).toBe("2026-04");
  });

  it("links codes that share a Slippi user ID, and ranks names by use", () => {
    const b = new PlayerStatsBuilder();
    b.add(game());
    b.add(game({ a: { connectCode: "NEW#9", displayName: "Alpha2" } }));
    b.add(game({ a: { displayName: "Alpha3" } }));
    b.add(game({ a: { displayName: "Alpha3" } }));
    expect(profileOf(b, "AAA#1").otherCodes).toEqual(["NEW#9"]);
    expect(profileOf(b, "NEW#9").otherCodes).toEqual(["AAA#1"]);
    expect(profileOf(b, "AAA#1").names.map((n) => n.name)).toEqual(["Alpha3", "Alpha"]);
    expect(profileOf(b, "BBB#2").otherCodes).toEqual([]);
  });

  it("skips players without a connect code", () => {
    const b = new PlayerStatsBuilder();
    b.add(game({ b: { connectCode: null } }));
    expect(b.size).toBe(1);
    expect(profileOf(b, "AAA#1").opponents).toEqual([]);
  });
});
