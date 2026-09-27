import { matchSet, normCode, type CandidateGame, type SggSet } from "./startgg";

const A = "AAA#1";
const B = "BBB#2";
const T0 = 1_700_000_000;

function set(over: Partial<SggSet> = {}, scores: [number, number] = [2, 1]): SggSet {
  return {
    id: 1,
    startedAt: T0,
    completedAt: T0 + 1200,
    fullRoundText: "Winners Final",
    winnerId: 10,
    games: [
      { orderNum: 1, winnerId: 10 },
      { orderNum: 2, winnerId: 20 },
      { orderNum: 3, winnerId: 10 },
    ],
    slots: [
      { entrant: { id: 10, participants: [{ gamerTag: "Aa", prefix: null }] }, standing: { stats: { score: { value: scores[0] } } } },
      { entrant: { id: 20, participants: [{ gamerTag: "Bb", prefix: "X" }] }, standing: { stats: { score: { value: scores[1] } } } },
    ],
    ...over,
  };
}

// A wins when winnerIndex points at the player holding code A.
const game = (id: string, dt: number, winner: "A" | "B" | null, fp: string | null = id): CandidateGame => ({
  replayId: id,
  t: T0 + dt,
  codes: { 0: A, 1: B },
  winnerIndex: winner === "A" ? 0 : winner === "B" ? 1 : null,
  fingerprint: fp,
});

describe("matchSet", () => {
  it("matches the last N decided games when every winner agrees", () => {
    const m = matchSet(set(), [A, B], [game("w", -900, "B"), game("g1", -60, "A"), game("g2", 400, "B"), game("g3", 800, "A")]);
    expect(m).toEqual({
      method: "games",
      games: [
        { replayId: "g1", n: 1, winner: 0 },
        { replayId: "g2", n: 2, winner: 1 },
        { replayId: "g3", n: 3, winner: 0 },
      ],
    });
  });

  it("uses one recording per game and skips undecided games", () => {
    const m = matchSet(set(), [A, B], [game("g1", 10, "A", "f1"), game("g1b", 11, "A", "f1"), game("x", 200, null), game("g2", 400, "B"), game("g3", 800, "A")]);
    expect(m?.games.map((g) => g.replayId)).toEqual(["g1", "g2", "g3"]);
  });

  it("rejects when a game winner disagrees or games are missing", () => {
    expect(matchSet(set(), [A, B], [game("g1", 10, "A"), game("g2", 400, "A"), game("g3", 800, "A")])).toBeNull();
    expect(matchSet(set(), [A, B], [game("g1", 10, "A"), game("g2", 400, "B")])).toBeNull();
  });

  it("ignores games outside the set's window", () => {
    expect(matchSet(set(), [A, B], [game("g1", 10, "A"), game("g2", 400, "B"), game("late", 1300, "A")])).toBeNull();
  });

  it("falls back to the score when start.gg has no per-game results", () => {
    const s = set({ games: null });
    expect(matchSet(s, [A, B], [game("g1", 10, "B"), game("g2", 400, "A"), game("g3", 800, "A")])?.method).toBe("score");
    expect(matchSet(s, [A, B], [game("g1", 10, "B"), game("g2", 400, "B"), game("g3", 800, "A")])).toBeNull();
  });

  it("skips DQs and unplayed sets", () => {
    expect(matchSet(set({ games: null }, [0, -1]), [A, B], [game("g1", 10, "A")])).toBeNull();
    expect(matchSet(set({ startedAt: null }), [A, B], [game("g1", 10, "A")])).toBeNull();
  });
});

describe("normCode", () => {
  it("uppercases valid connect codes and rejects anything else", () => {
    expect(normCode(" mang#0 ")).toBe("MANG#0");
    expect(normCode("not a code")).toBeNull();
    expect(normCode(null)).toBeNull();
  });
});
