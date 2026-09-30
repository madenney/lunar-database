/**
 * The clip search index (docs/clip-search.md): moments from the stats run's
 * `clipper` detail files, one document per combo / edgeguard / early quit-out,
 * with both players resolved so searches need no join. Pure mapping here;
 * scripts/buildClips.ts reads the files and writes the collection.
 *
 * What gets indexed (decision 1, confirmed 2026-09-29): combos with 4+ moves or
 * a kill, every edgeguard, every early quit-out. Only usable replays (so no
 * hidden duplicate recordings) and only 1v1s (the detectors run on 1v1s only).
 */
import type { ComboRow, EdgeguardRow, EarlyQuitOutRow, MoveRow } from "./gameStats";

export const MIN_COMBO_MOVES = 4;

export type ClipType = "combo" | "edgeguard" | "quitout";

export interface ClipPlayer {
  port: number;
  characterId: number | null;
  connectCode: string | null;
  displayName: string | null;
}

export interface ClipDoc {
  replayId: unknown;
  type: ClipType;
  startFrame: number;
  endFrame: number | null;
  /** The game's length in frames, so Clipper can clamp its lead-in/out padding. */
  gameFrames: number | null;
  stageId: number | null;
  source: string | null;
  startAt: Date | null;
  /** Combos and quit-outs: who did it. Edgeguards: the edgeguarder. */
  attacker: ClipPlayer;
  /** Combos and quit-outs: who got hit. Edgeguards: who died. */
  victim: ClipPlayer;
  startPercent: number | null;
  endPercent: number | null;
  /** endPercent - startPercent; null while unfinished. */
  damage: number | null;
  moves: number;
  didKill: boolean;
  /** [moveId, frame, damage, hitCount], enough to rebuild Clipper's ClipInterface. */
  moveList: MoveRow[];
  /** Edgeguards: the detector's interestingness score (metrics.score). */
  score: number | null;
  /** "Best first" sort key for every type: damage for combos and quit-outs, score for edgeguards. */
  rank: number;
  metrics: Record<string, unknown> | null;
  detail: { run: string; extractor: "clipper"; version: number; shard: string };
}

/** The replay fields the mapping needs. */
export interface ClipReplay {
  _id: unknown;
  usable?: boolean | null;
  duration?: number | null;
  stageId?: number | null;
  source?: string | null;
  startAt?: Date | null;
  players?: { playerIndex: number; characterId?: number | null; connectCode?: string | null; displayName?: string | null }[];
}

/** One line of a clipper detail file. */
export interface ClipperLine {
  r: string;
  combos?: ComboRow[];
  edgeguards?: EdgeguardRow[];
  earlyQuitOut?: EarlyQuitOutRow | null;
}

const round1 = (n: number | null | undefined) => (n == null ? null : Math.round(n * 10) / 10);

/** Clips for one game. Empty unless the replay is usable and a 1v1. */
export function clipsFromLine(line: ClipperLine, replay: ClipReplay, detail: ClipDoc["detail"]): ClipDoc[] {
  if (!replay.usable || (replay.players?.length ?? 0) !== 2) return [];
  const byPort = new Map((replay.players ?? []).map((p) => [p.playerIndex, p]));
  const player = (port: number): ClipPlayer => {
    const p = byPort.get(port);
    return { port, characterId: p?.characterId ?? null, connectCode: p?.connectCode || null, displayName: p?.displayName || null };
  };
  const base = {
    replayId: replay._id,
    gameFrames: replay.duration ?? null,
    stageId: replay.stageId ?? null,
    source: replay.source ?? null,
    startAt: replay.startAt ?? null,
    detail,
  };
  const out: ClipDoc[] = [];

  for (const [comboer, comboee, start, end, startPct, endPct, kill, moveList] of line.combos ?? []) {
    if (moveList.length < MIN_COMBO_MOVES && !kill) continue;
    out.push({
      ...base,
      type: "combo",
      startFrame: start,
      endFrame: end,
      attacker: player(comboer),
      victim: player(comboee),
      startPercent: round1(startPct),
      endPercent: round1(endPct),
      damage: endPct == null ? null : round1(endPct - startPct),
      moves: moveList.length,
      didKill: !!kill,
      moveList,
      score: null,
      rank: endPct == null ? 0 : round1(endPct - startPct)!,
      metrics: null,
    });
  }

  for (const [victim, edgeguarder, start, end, metrics] of line.edgeguards ?? []) {
    const score = typeof metrics?.score === "number" ? metrics.score : null;
    out.push({
      ...base,
      type: "edgeguard",
      startFrame: start,
      endFrame: end,
      attacker: player(edgeguarder),
      victim: player(victim),
      startPercent: null,
      endPercent: null,
      damage: null,
      moves: typeof metrics?.hits === "number" ? metrics.hits : 0,
      didKill: true,
      moveList: [],
      score: score == null ? null : round1(score),
      rank: score == null ? 0 : round1(score)!,
      metrics: metrics ?? null,
    });
  }

  const q = line.earlyQuitOut;
  if (q) {
    const [comboer, quitter, start, quitFrame, startPct, pctAtQuit, moveList] = q;
    out.push({
      ...base,
      type: "quitout",
      startFrame: start,
      endFrame: quitFrame,
      attacker: player(comboer),
      victim: player(quitter),
      startPercent: round1(startPct),
      endPercent: round1(pctAtQuit),
      damage: round1(pctAtQuit - startPct),
      moves: moveList.length,
      didKill: false,
      moveList,
      score: null,
      rank: round1(pctAtQuit - startPct)!,
      metrics: null,
    });
  }
  return out;
}

/**
 * Indexes of the clips collection. Every search starts with `type`, narrows by
 * an equality (characters, a player, kill/zero-to-death) and sorts by `rank`
 * ("best") or `startAt`. Stage, source, dates, damage and move filters ride
 * along. Without these a sorted search scans all ~27M clips (measured: 280 s).
 */
export const CLIP_INDEXES: { key: Record<string, 1 | -1>; name: string; partialFilterExpression?: Record<string, unknown> }[] = [
  { key: { type: 1, rank: -1 }, name: "type_rank" },
  { key: { type: 1, startAt: -1 }, name: "type_date" },
  { key: { type: 1, "attacker.characterId": 1, "victim.characterId": 1, rank: -1 }, name: "type_chars_rank" },
  { key: { type: 1, "attacker.characterId": 1, startAt: -1 }, name: "type_attChar_date" },
  { key: { type: 1, "victim.characterId": 1, rank: -1 }, name: "type_vicChar_rank" },
  { key: { type: 1, "attacker.connectCode": 1, rank: -1 }, name: "type_attCode_rank" },
  { key: { type: 1, "attacker.connectCode": 1, startAt: -1 }, name: "type_attCode_date" },
  { key: { type: 1, "victim.connectCode": 1, rank: -1 }, name: "type_vicCode_rank" },
  { key: { type: 1, didKill: 1, startPercent: 1, rank: -1 }, name: "type_kill_start_rank" },
  // Zero-to-deaths by character/matchup: only those clips (a few % of combos).
  // Without it "Falco zero-to-deaths" scanned for 8.6 s.
  {
    key: { type: 1, "attacker.characterId": 1, "victim.characterId": 1, rank: -1 },
    name: "ztd_chars_rank",
    partialFilterExpression: { didKill: true, startPercent: 0 },
  },
  { key: { replayId: 1 }, name: "replayId" },
];
