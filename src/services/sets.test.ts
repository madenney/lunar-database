import { orderGameFiles, parseContextSet, parseJungleSet } from "./sets";
import { slugify, startggTournamentSlug, tournamentFromPath, tournamentFromStartgg } from "./tournaments";

describe("tournamentFromPath", () => {
  it("treats a plain top-level folder as one tournament", () => {
    expect(tournamentFromPath("tournament/Pound 2019/Station 101-A/Game_1.slp")).toEqual({ key: "pound-2019", name: "Pound 2019", listed: true });
  });
  it("splits series folders into their events", () => {
    // Renamed to match the event's Jungle set.json, so folder- and set-grouped games share a page.
    expect(tournamentFromPath("tournament/King of the Jungle/kotj_7/friendlies/g.slp")).toEqual({ key: "kotj-7", name: "KOTJ #7", listed: true });
    expect(tournamentFromPath("tournament/Da Greenhouse/Da Greenhouse #60 1-10-2025/x/g.slp")?.name).toBe("Da Greenhouse #60 1-10-2025");
    expect(tournamentFromPath("tournament/The Local/Season 2/The Local 2x07/6/g.slp")?.name).toBe("The Local 2x07");
    expect(tournamentFromPath("tournament/The Local/6x02/g.slp")?.name).toBe("The Local 6x02");
  });
  it("marks non-tournament folders unlisted and ignores other sources", () => {
    expect(tournamentFromPath("tournament/Friendlies/d_haus/g.slp")?.listed).toBe(false);
    expect(tournamentFromPath("netplay/Nomad/2024-01/g.slp")).toBeNull();
  });
});

describe("start.gg tournaments", () => {
  it("keys by the tournament slug and adds the edition number to the name", () => {
    expect(startggTournamentSlug("tournament/midlane-melee-177/event/melee-singles")).toBe("midlane-melee-177");
    expect(tournamentFromStartgg("Midlane Melee", "tournament/midlane-melee-177/event/melee-singles")).toEqual({
      key: "midlane-melee-177", name: "Midlane Melee 177", listed: true, startggSlug: "midlane-melee-177",
    });
    expect(tournamentFromStartgg("The Big House 11", "tournament/the-big-house-11/event/melee-singles")?.name).toBe("The Big House 11");
    expect(slugify("Emi's Haunted House!")).toBe("emis-haunted-house");
  });
});

describe("parseContextSet", () => {
  const slot = (name: string, port: number, score: number) => ({ displayNames: [name], prefixes: [""], ports: [port], score });
  const ctx = {
    bestOf: 3,
    startMs: 1749089105667,
    scores: [
      { slots: [slot("A", 1, 0), slot("B", 2, 0)] },
      { slots: [slot("A", 1, 0), slot("B", 2, 1)] },
      { slots: [slot("A", 1, 1), slot("B", 2, 1)] },
    ],
    finalScore: { slots: [slot("A", 1, 2), slot("B", 2, 1)] },
    startgg: {
      tournament: { name: "Midlane Melee", location: "Chicago, IL" },
      event: { id: 1, name: "Melee Singles", slug: "tournament/midlane-melee-177/event/melee-singles" },
      set: { id: 89928932, fullRoundText: "Winners Final" },
    },
  };

  it("orders games by their number and reads each game's winner from the score progression", () => {
    const s = parseContextSet(ctx, "tournament/Midlane Melee/luckystats/source_1", ["03-3_-_x.slp", "01-1_-_x.slp", "02-2_-_x.slp", "context.json"]);
    expect(s._id).toBe("sgg-89928932");
    expect(s.tournament.key).toBe("midlane-melee-177");
    expect(s.round).toBe("Winners Final");
    expect(s.games).toEqual([
      { file: "01-1_-_x.slp", n: 1, winner: 1 },
      { file: "02-2_-_x.slp", n: 2, winner: 0 },
      { file: "03-3_-_x.slp", n: 3, winner: 0 },
    ]);
    expect(s.winner).toBe(0);
    expect(s.players.map((p) => [p.name, p.port, p.score])).toEqual([["A", 1, 2], ["B", 2, 1]]);
  });

  it("falls back to the folder when the export has no start.gg data", () => {
    const { startgg: _s, ...local } = ctx;
    const s = parseContextSet(local, "tournament/Gourmet Bash #5/Bracket LR2 - A vs B", ["1 - x.slp"]);
    expect(s._id).toMatch(/^dir-/);
    expect(s.tournament.name).toBe("Gourmet Bash #5");
  });
});

describe("parseJungleSet", () => {
  it("reads players from the title and winners per game", () => {
    const s = parseJungleSet(
      { event: "KOTJ #7", round: "Grand Finals", title: "Goober vs OBZDN - Grand Finals - KOTJ #7", games: [{ game: 2, file: "game-2.slp", winner: "p2" }, { game: 1, file: "game-1.slp", winner: "p1" }, { game: 3, file: "game-3.slp", winner: "p2" }] },
      "tournament/King of the Jungle/kotj_7/24-grand-finals-goober-vs-obzdn"
    );
    expect(s.tournament).toEqual({ key: "kotj-7", name: "KOTJ #7", listed: true });
    expect(s.players.map((p) => [p.name, p.score])).toEqual([["Goober", 1], ["OBZDN", 2]]);
    expect(s.winner).toBe(1);
    expect(s.games.map((g) => g.file)).toEqual(["game-1.slp", "game-2.slp", "game-3.slp"]);
  });
});

describe("orderGameFiles", () => {
  it("keeps only replays, in numeric order", () => {
    expect(orderGameFiles(["game-10.slp", "game-2.slp", "set.json", "game-1.slp"])).toEqual(["game-1.slp", "game-2.slp", "game-10.slp"]);
  });
});
