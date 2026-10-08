import { buildReplaySearchQuery, replayIdList, MAX_REPLAY_IDS } from "./replaySearchQuery";
import { parseFilter, hasFilterOrLimit, MAX_SIZE_MB } from "./replayFilter";

// Pure query-building tests: no MongoDB connection is needed.
const inner = (params: Parameters<typeof buildReplaySearchQuery>[0]) => buildReplaySearchQuery(params).$and[1];

describe("buildReplaySearchQuery dates", () => {
  it("treats a date-only endDate as the whole UTC day", () => {
    const q = inner({ startDate: "2024-01-15", endDate: "2024-01-15" });
    expect(q.startAt.$gte).toEqual(new Date("2024-01-15T00:00:00Z"));
    expect(q.startAt.$lt).toEqual(new Date("2024-01-16T00:00:00Z"));
    expect(q.startAt.$lte).toBeUndefined();
  });

  it("keeps an exact timestamp endDate inclusive", () => {
    const q = inner({ endDate: "2024-01-15T12:30:00Z" });
    expect(q.startAt.$lte).toEqual(new Date("2024-01-15T12:30:00Z"));
    expect(q.startAt.$lt).toBeUndefined();
  });

  it("ignores unparseable dates", () => {
    expect(inner({ endDate: "not-a-date" }).startAt).toBeUndefined();
  });
});

describe("buildReplaySearchQuery lists", () => {
  it("trims values and drops empties", () => {
    const q = inner({ p1ConnectCode: "MANG#0, ZAIN#0,, " });
    expect(q.players.$elemMatch.connectCode).toEqual({ $in: ["MANG#0", "ZAIN#0"] });
  });
});

describe("buildReplaySearchQuery two-sided matchups", () => {
  const q = inner({ p1CharacterId: "2", p2CharacterId: "20" });
  const [pairBranch, multiBranch] = q.$or;

  it("finds 1v1s by their indexed character pair, either order", () => {
    expect(pairBranch).toEqual({ charPair: { $in: ["2-20"] } });
    expect(inner({ p1CharacterId: "20,9", p2CharacterId: "2" }).$or[0]).toEqual({ charPair: { $in: ["2-20", "2-9"] } });
  });

  it("checks 3-4 player games slot by slot, each side a different slot", () => {
    expect(multiBranch.charPair).toBe("multi");
    expect(multiBranch.players).toEqual({
      $all: [{ $elemMatch: { characterId: 2 } }, { $elemMatch: { characterId: 20 } }],
    });
    expect(multiBranch.$or).toHaveLength(12);
    expect(multiBranch.$or).toContainEqual({ "players.2.characterId": 2, "players.3.characterId": 20 });
    for (const branch of multiBranch.$or) {
      const slots = Object.keys(branch).map((k) => k.split(".")[1]);
      expect(new Set(slots).size).toBe(2);
    }
  });

  it("keeps the general form when a side also names a player", () => {
    const withCode = inner({ p1CharacterId: "2", p1ConnectCode: "MANG#0", p2CharacterId: "20" });
    expect(withCode.charPair).toBeUndefined();
    expect(withCode.$or).toHaveLength(12);
  });
});

describe("buildReplaySearchQuery tournaments", () => {
  it("matches one or several tournament keys and drops invalid ones", () => {
    // Always with $type: "string", which lets MongoDB narrow the partial
    // tournament index by key (without it, it scanned all ~440k entries).
    expect(inner({ tournament: "KOTJ-7" }).tournamentKey).toEqual({ $eq: "kotj-7", $type: "string" });
    expect(inner({ tournament: "kotj-7, midlane-melee-177,kotj-7" }).tournamentKey).toEqual({
      $in: ["kotj-7", "midlane-melee-177"],
      $type: "string",
    });
    expect(inner({ tournament: "$ne,../x" }).tournamentKey).toBeUndefined();
  });
});

describe("parseFilter", () => {
  it("keeps valid tournament keys, which count as a filter", () => {
    const filter = parseFilter({ tournament: "kotj-7,Bad Key" });
    expect(filter.tournament).toBe("kotj-7");
    expect(hasFilterOrLimit(filter).hasFilter).toBe(true);
    expect(parseFilter({ tournament: { $ne: null } }).tournament).toBeUndefined();
  });

  it("keeps every value of a long list instead of cutting the string", () => {
    const codes = Array.from({ length: 20 }, (_, i) => `CODE#${100 + i}`);
    const filter = parseFilter({ p1ConnectCode: codes.join(",") });
    expect(filter.p1ConnectCode!.split(",")).toEqual(codes);
  });

  it("caps list length and trims values", () => {
    const codes = Array.from({ length: 25 }, (_, i) => ` A#${i} `);
    expect(parseFilter({ p1ConnectCode: codes.join(",") }).p1ConnectCode!.split(",")).toHaveLength(20);
    expect(parseFilter({ p2ConnectCode: " MANG#0 , ,ZAIN#0" }).p2ConnectCode).toBe("MANG#0,ZAIN#0");
  });

  it("caps the size budget and ignores unknown keys", () => {
    const filter = parseFilter({ maxSizeMb: 20000, filters: { characters: "Fox" } });
    expect(filter).toEqual({ maxSizeMb: MAX_SIZE_MB });
    expect(hasFilterOrLimit(filter)).toEqual({ hasFilter: false, hasLimit: true });
  });

  it("does not count sort or limits as filters", () => {
    expect(hasFilterOrLimit(parseFilter({ sort: "startAt:1" }))).toEqual({ hasFilter: false, hasLimit: false });
    expect(hasFilterOrLimit(parseFilter({ stageId: "31" }))).toEqual({ hasFilter: true, hasLimit: false });
  });
});

describe("replayIdList", () => {
  it("keeps valid ids once, lowercased, from an array or a comma list", () => {
    const id = "6abbe33244a1db24ff7a5525";
    expect(replayIdList([id, id.toUpperCase(), "nope", 5, `${id}x`])).toEqual([id]);
    expect(replayIdList(`${id}, ${"a".repeat(24)}`)).toEqual([id, "a".repeat(24)]);
    expect(replayIdList(undefined)).toEqual([]);
  });
  it("caps the list", () => {
    const many = Array.from({ length: MAX_REPLAY_IDS + 5 }, (_, i) => i.toString(16).padStart(24, "0"));
    expect(replayIdList(many)).toHaveLength(MAX_REPLAY_IDS);
  });
});
