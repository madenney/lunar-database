import { sameGame, pickCanonical } from "./duplicates";

const r = (id: string, duration: number | null, fileSize: number | null, setId: string | null = null) => ({ _id: id, duration, fileSize, setId });

describe("duplicate recordings", () => {
  it("treats recordings as one game only when every length is known and close", () => {
    expect(sameGame([r("a", 5000, 1), r("b", 5060, 1)])).toBe(true);
    expect(sameGame([r("a", 5000, 1), r("b", 4000, 1)])).toBe(false); // a partial capture
    expect(sameGame([r("a", 5000, 1), r("b", null, 1)])).toBe(false);
    expect(sameGame([r("a", 5000, 1)])).toBe(false);
  });

  it("keeps the set-linked copy, else the largest, else the first indexed", () => {
    expect(pickCanonical([r("a", 1, 900), r("b", 1, 100, "sgg-1")])._id).toBe("b");
    expect(pickCanonical([r("a", 1, 100), r("b", 1, 900)])._id).toBe("b");
    expect(pickCanonical([r("b", 1, 100), r("a", 1, 100)])._id).toBe("a");
  });
});

import { isUsableReplay, NOT_JUNK_QUERY } from "../models/Replay";

describe("usable excludes hidden duplicates", () => {
  const game = { stageId: 31, duration: 5000, players: [{ characterId: 2 }] };
  it("in code and in the query it mirrors", () => {
    expect(isUsableReplay(game)).toBe(true);
    expect(isUsableReplay({ ...game, duplicateOf: "6abbe33244a1db24ff7a5525" })).toBe(false);
    expect(NOT_JUNK_QUERY).toHaveProperty("duplicateOf", null);
  });
});
