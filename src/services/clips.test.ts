import { clipsFromLine, type ClipReplay } from "./clips";
import type { MoveRow } from "./gameStats";

const detail = { run: "main", extractor: "clipper" as const, version: 1, shard: "main-abc" };
const replay: ClipReplay = {
  _id: "6abbe33244a1db24ff7a5525",
  usable: true,
  duration: 9000,
  stageId: 31,
  source: "netplay",
  startAt: new Date("2025-03-01T00:00:00Z"),
  players: [
    { playerIndex: 0, characterId: 9, connectCode: "AAA#1", displayName: "Marthy" },
    { playerIndex: 1, characterId: 2, connectCode: "BBB#2", displayName: "" },
  ],
};
const moves = (n: number): MoveRow[] => Array.from({ length: n }, (_, i) => [i + 1, 100 + i * 10, 8.25, 1]);

describe("clipsFromLine", () => {
  it("keeps combos with 4+ moves or a kill, and resolves both players", () => {
    const clips = clipsFromLine(
      {
        r: "x",
        combos: [
          [0, 1, 100, 200, 10, 60.55, 0, moves(4)], // 4 moves: kept
          [0, 1, 300, 340, 0, 20, 0, moves(3)], // 3 moves, no kill: dropped
          [1, 0, 500, 560, 80, null, 1, moves(2)], // kill: kept, unfinished percent
        ],
      },
      replay,
      detail
    );
    expect(clips.map((c) => [c.type, c.moves, c.didKill])).toEqual([["combo", 4, false], ["combo", 2, true]]);
    expect(clips[0]).toMatchObject({
      startFrame: 100,
      endFrame: 200,
      gameFrames: 9000,
      stageId: 31,
      attacker: { port: 0, characterId: 9, connectCode: "AAA#1", displayName: "Marthy" },
      victim: { port: 1, characterId: 2, connectCode: "BBB#2", displayName: null },
      startPercent: 10,
      endPercent: 60.6,
      damage: 50.6,
      detail,
    });
    expect(clips[0].moveList).toHaveLength(4);
    expect(clips[1]).toMatchObject({ endPercent: null, damage: null, rank: 0 });
    expect(clips[0].rank).toBe(50.6);
  });

  it("maps edgeguards with the edgeguarder as attacker and the detector score", () => {
    const [eg] = clipsFromLine({ r: "x", edgeguards: [[1, 0, 700, 820, { hits: 3, score: 12.345 }]] }, replay, detail);
    expect(eg).toMatchObject({ type: "edgeguard", attacker: { port: 0 }, victim: { port: 1 }, score: 12.3, rank: 12.3, moves: 3, didKill: true });
  });

  it("maps an early quit-out", () => {
    const [q] = clipsFromLine({ r: "x", earlyQuitOut: [0, 1, 900, 960, 30, 95, moves(5)] }, replay, detail);
    expect(q).toMatchObject({ type: "quitout", attacker: { port: 0 }, victim: { port: 1 }, damage: 65, moves: 5 });
  });

  it("indexes nothing for unusable replays (e.g. hidden duplicates) or non-1v1s", () => {
    const line = { r: "x", combos: [[0, 1, 100, 200, 10, 60, 1, moves(4)]] as any };
    expect(clipsFromLine(line, { ...replay, usable: false }, detail)).toEqual([]);
    expect(clipsFromLine(line, { ...replay, players: [...replay.players!, { playerIndex: 2, characterId: 20 }] }, detail)).toEqual([]);
  });
});
