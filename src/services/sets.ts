import crypto from "crypto";
import { slugify, tournamentFromPath, tournamentFromStartgg, type TournamentRef } from "./tournaments";

/**
 * Sets from the metadata that ships with tournament replays (scripts/buildSets.ts):
 *  - context.json, from start.gg set exports (Lucky Stats, donated set zips):
 *    start.gg tournament/event/set IDs, players with ports and per-game scores;
 *  - set.json, from the Jungle tools: event, round, title and per-game winners.
 * Each maps a folder of game files to one set with its games in order.
 */

export interface SetPlayer {
  name: string;
  prefix: string | null;
  /** Slippi port (1-4) the player used, when known. */
  port: number | null;
  score: number | null;
}

export interface SetGameRef {
  /** Game file name within the set's folder. */
  file: string;
  n: number;
  /** Index into players of the game's winner, when known. */
  winner: number | null;
}

export interface ParsedSet {
  _id: string;
  source: "startgg-export" | "jungle";
  tournament: TournamentRef;
  event: string | null;
  round: string | null;
  bestOf: number | null;
  location: string | null;
  startgg: { setId: number | null; eventId: number | null; eventSlug: string | null } | null;
  players: SetPlayer[];
  /** Index into players of the set winner, when known. */
  winner: number | null;
  games: SetGameRef[];
  startAt: Date | null;
}

/** Game files in play order: "01-1_-_...slp", "1 - ...slp", "game-3.slp" sort by their number. */
export function orderGameFiles(files: string[]): string[] {
  const num = (f: string) => Number(/(\d+)/.exec(f)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return files.filter((f) => f.toLowerCase().endsWith(".slp")).sort((a, b) => num(a) - num(b) || a.localeCompare(b));
}

const dirId = (dir: string) => "dir-" + crypto.createHash("sha1").update(dir).digest("hex").slice(0, 20);

type ScoreSlot = { displayNames?: string[]; prefixes?: string[]; ports?: number[]; score?: number };
type Context = {
  bestOf?: number;
  startMs?: number;
  scores?: { slots: ScoreSlot[] }[];
  finalScore?: { slots: ScoreSlot[] };
  startgg?: {
    tournament?: { name?: string; location?: string };
    event?: { id?: number; name?: string; slug?: string };
    set?: { id?: number; fullRoundText?: string };
  };
};

/** A set from a start.gg export's context.json; `dir` is the folder's archive path. */
export function parseContextSet(ctx: Context, dir: string, files: string[]): ParsedSet {
  const final = ctx.finalScore?.slots ?? ctx.scores?.[ctx.scores.length - 1]?.slots ?? [];
  const players: SetPlayer[] = final.map((s) => ({
    name: s.displayNames?.[0] ?? "Player",
    prefix: s.prefixes?.[0] || null,
    port: s.ports?.[0] ?? null,
    score: typeof s.score === "number" ? s.score : null,
  }));
  const ordered = orderGameFiles(files);
  // scores[i] is the score going into game i+1; the next entry (or the final
  // score) shows whose score went up, i.e. who won game i+1.
  const snapshots = [...(ctx.scores ?? []).map((s) => s.slots), final];
  const games: SetGameRef[] = ordered.map((file, i) => {
    const before = snapshots[i];
    const after = snapshots[i + 1];
    let winner: number | null = null;
    if (before && after) {
      const k = after.findIndex((s, j) => (s.score ?? 0) > (before[j]?.score ?? 0));
      winner = k >= 0 ? k : null;
    }
    return { file, n: i + 1, winner };
  });
  const scores = players.map((p) => p.score ?? -1);
  const winner = scores.length === 2 && scores[0] !== scores[1] ? (scores[0] > scores[1] ? 0 : 1) : null;
  const sg = ctx.startgg;
  const tournament =
    tournamentFromStartgg(sg?.tournament?.name, sg?.event?.slug) ?? tournamentFromPath(`${dir}/x.slp`) ?? { key: "unknown", name: "Unknown", listed: false };
  return {
    _id: sg?.set?.id ? `sgg-${sg.set.id}` : dirId(dir),
    source: "startgg-export",
    tournament,
    event: sg?.event?.name ?? null,
    round: sg?.set?.fullRoundText ?? null,
    bestOf: ctx.bestOf ?? null,
    location: sg?.tournament?.location ?? null,
    startgg: sg ? { setId: sg.set?.id ?? null, eventId: sg.event?.id ?? null, eventSlug: sg.event?.slug ?? null } : null,
    players,
    winner,
    games,
    startAt: ctx.startMs ? new Date(ctx.startMs) : null,
  };
}

type JungleSet = {
  event?: string;
  eventNumber?: string;
  round?: string;
  title?: string;
  games?: { game: number; file: string; winner?: "p1" | "p2" }[];
};

/** A set from a Jungle set.json. Player names come from its title ("A vs B - Round - Event"). */
export function parseJungleSet(set: JungleSet, dir: string): ParsedSet {
  const [a, b] = (set.title ?? "").split(" - ")[0].split(/\s+vs\.?\s+/i);
  const names = [a?.trim() || "Player 1", b?.trim() || "Player 2"];
  const games: SetGameRef[] = [...(set.games ?? [])]
    .sort((x, y) => x.game - y.game)
    .map((g) => ({ file: g.file, n: g.game, winner: g.winner === "p1" ? 0 : g.winner === "p2" ? 1 : null }));
  const wins = [0, 1].map((k) => games.filter((g) => g.winner === k).length);
  const eventName = set.event?.trim() || null;
  const tournament: TournamentRef = eventName
    ? { key: slugify(eventName), name: eventName, listed: true }
    : tournamentFromPath(`${dir}/x.slp`) ?? { key: "unknown", name: "Unknown", listed: false };
  return {
    _id: dirId(dir),
    source: "jungle",
    tournament,
    event: eventName,
    round: set.round ?? null,
    bestOf: null,
    location: null,
    startgg: null,
    players: names.map((name, k) => ({ name, prefix: null, port: null, score: wins[k] })),
    winner: wins[0] === wins[1] ? null : wins[0] > wins[1] ? 0 : 1,
    games,
    startAt: null,
  };
}
