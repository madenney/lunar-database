import { parseClipSearch } from "./clips";

describe("parseClipSearch", () => {
  it("requires a known type", () => {
    expect(parseClipSearch({})).toHaveProperty("error");
    expect(parseClipSearch({ type: "phantom" })).toHaveProperty("error");
  });

  it("builds an index-friendly filter: type first, equalities, newest first, infinites hidden", () => {
    const q = parseClipSearch({ type: "combo", attackerCharacterId: "2", victimCharacterId: [9, 20], stageId: "31", killOnly: true, minDamage: 60 });
    expect(q).toMatchObject({
      filter: { type: "combo", "attacker.characterId": 2, "victim.characterId": { $in: [9, 20] }, stageId: 31, didKill: true, damage: { $gte: 60 }, infinite: { $ne: true } },
      sort: { startAt: -1 },
      page: 1,
      limit: 25,
    });
  });

  it("normalizes connect codes and drops invalid values", () => {
    const q = parseClipSearch({ type: "edgeguard", attackerConnectCode: "mang#0, not a code", stageId: "abc", minDamage: 50 }) as any;
    expect(q.filter).toEqual({ type: "edgeguard", "attacker.connectCode": "MANG#0", infinite: { $ne: true } });
  });

  it("zero-to-death means a kill from 0%", () => {
    expect((parseClipSearch({ type: "combo", zeroToDeath: true }) as any).filter).toMatchObject({ didKill: true, startPercent: 0 });
  });

  it("sorts newest by default, best on request, and leaves undated clips out of oldest-first", () => {
    expect((parseClipSearch({ type: "combo" }) as any).sort).toEqual({ startAt: -1 });
    expect((parseClipSearch({ type: "combo", sort: "best" }) as any).sort).toEqual({ rank: -1 });
    expect((parseClipSearch({ type: "combo", includeInfinites: true }) as any).filter.infinite).toBeUndefined();
    const oldest = parseClipSearch({ type: "combo", sort: "oldest", startDate: "2024-01-01" }) as any;
    expect(oldest.sort).toEqual({ startAt: 1 });
    expect(oldest.filter.startAt).toEqual({ $gte: new Date("2024-01-01T00:00:00Z"), $ne: null });
  });

  it("caps limit and page", () => {
    expect(parseClipSearch({ type: "combo", limit: 5000, page: 99999 })).toMatchObject({ limit: 100, page: 400 });
  });
});
