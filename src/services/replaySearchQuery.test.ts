import { buildReplaySearchQuery } from "./replaySearchQuery";
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

  it("requires both sides somewhere in the players array", () => {
    expect(q.players).toEqual({
      $all: [{ $elemMatch: { characterId: 2 } }, { $elemMatch: { characterId: 20 } }],
    });
  });

  it("matches each side to a different slot among four players", () => {
    expect(q.$or).toHaveLength(12);
    expect(q.$or).toContainEqual({ "players.2.characterId": 2, "players.3.characterId": 20 });
    expect(q.$or).toContainEqual({ "players.1.characterId": 2, "players.0.characterId": 20 });
    for (const branch of q.$or) {
      const slots = Object.keys(branch).map((k) => k.split(".")[1]);
      expect(new Set(slots).size).toBe(2);
    }
  });
});

describe("parseFilter", () => {
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
