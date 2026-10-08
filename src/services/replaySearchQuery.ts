/**
 * Builds a MongoDB query from replay search parameters.
 * Shared by GET /api/replays, POST /api/replays/estimate, POST /api/jobs and the bundle worker.
 */
import { Types } from "mongoose";
import { Replay, REPLAY_SOURCES } from "../models/Replay";

export interface ReplaySearchParams {
  p1CharacterId?: string;
  p1ConnectCode?: string;
  p1DisplayName?: string;
  /** Comma-joined rank tiers (see RANK_KEYS) for one side of the matchup, e.g.
   *  "master,diamond". Ranked dataset only — each player's displayName encodes
   *  their tier. When both p1Rank and p2Rank are set, they match as an
   *  order-independent matchup (e.g. Master vs Diamond); one side alone means
   *  "a game containing a player of that tier". Absent/empty = no rank filter. */
  p1Rank?: string;
  p2CharacterId?: string;
  p2ConnectCode?: string;
  p2DisplayName?: string;
  p2Rank?: string;
  stageId?: string;
  startDate?: string;
  endDate?: string;
  /** Comma-joined subset of REPLAY_SOURCES, e.g. "tournament,ranked".
   *  Absent/empty means no filter (all sources). */
  source?: string;
  /** Comma-joined tournament keys (e.g. "kotj-7,midlane-melee-177"); games of any of them. */
  tournament?: string;
  /** Exactly these replays (24-hex ids, e.g. the games behind chosen clips). Combines with any other field. */
  replayIds?: string[];
  /** The games behind a clip search (services/clipSearch.ts canonicalClipSearch). Resolved
   *  in batches by the estimator and bundler, never through buildReplaySearchQuery. */
  clipSearch?: string;
  maxFiles?: number;
  maxSizeMb?: number;
  /** "field:dir" e.g. "startAt:-1". Used so a limited selection (maxFiles) picks
   *  the same first-N rows the UI shows in that sort order. */
  sort?: string;
}

const SORT_ALLOWLIST = ["startAt", "indexedAt", "duration"];

// Ranked replays are anonymized: each player's displayName is their rank tier
// rather than a name. These are the only tiers present in the dataset — there is
// no Bronze/Silver/Gold or Grandmaster data. Keep in sync with RANKS in the
// frontend's downloadFilters.ts.
export const RANK_KEYS = ["platinum", "diamond", "master"] as const;
const RANK_DISPLAY_NAME: Record<string, string> = {
  platinum: "Platinum Player",
  diamond: "Diamond Player",
  master: "Master Player",
};

/** Parse a "field:dir" sort string into a Mongo sort object (default: newest). */
export function parseSort(sort?: string): Record<string, 1 | -1> {
  if (sort) {
    const [field, dir] = sort.split(":");
    if (SORT_ALLOWLIST.includes(field) && (dir === "1" || dir === "-1")) {
      return { [field]: Number(dir) as 1 | -1 };
    }
  }
  return { startAt: -1 };
}

/**
 * The query and sort for the replays a search selects. The list, estimate, job
 * creation and bundle worker all use this, so they agree on the same set.
 *
 * Ascending date order excludes undated replays: Mongo sorts nulls first, which
 * would flood "oldest" with undated games. That exclusion must never empty a
 * search, though. The whole `ranked` source is undated (anonymisation stripped
 * its metadata), so when nothing dated matches, the undated replays are kept.
 */
export async function resolveSelection(
  params: ReplaySearchParams
): Promise<{ query: Record<string, any>; sortObj: Record<string, 1 | -1>; hint?: Record<string, 1 | -1> }> {
  const sortObj = parseSort(params.sort);
  const query = buildReplaySearchQuery(params);
  const hint = selectionHint(params);
  if (sortObj.startAt !== 1) return { query, sortObj, hint };
  const dated = { $and: [query, { startAt: { $ne: null } }] };
  let probe = Replay.findOne(dated).select("_id").maxTimeMS(10000);
  if (hint) probe = probe.hint(hint);
  const anyDated = await probe.lean();
  return { query: anyDated ? dated : query, sortObj, hint };
}

/**
 * An index to force for this selection, when MongoDB's own choice is known to be
 * bad. A tournament holds at most a few thousand games, but sorted oldest-first
 * the planner walked the whole startAt index (2.2M keys, ~6 s under load).
 */
export function selectionHint(params: ReplaySearchParams): Record<string, 1 | -1> | undefined {
  return tournamentKeys(params.tournament).length ? { tournamentKey: 1, startAt: -1 } : undefined;
}

const MAX_PLAYERS = 4;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const MAX_LIST_VALUES = 20;

function splitParam(v: string | undefined, max = MAX_LIST_VALUES): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean).slice(0, max) : [];
}

function buildPlayerMatch(
  charIds: string[],
  codes: string[],
  names: string[],
  rankNames: string[] = [],
): Record<string, any> {
  const match: any = {};
  if (charIds.length === 1) match.characterId = Number(charIds[0]);
  else if (charIds.length > 1) match.characterId = { $in: charIds.map(Number) };
  if (codes.length === 1) match.connectCode = codes[0];
  else if (codes.length > 1) match.connectCode = { $in: codes };
  // Rank is an exact displayName match on the tier label; it takes precedence
  // over a (tag) name prefix on the same slot. They're mutually exclusive in
  // practice — the rank UI only appears for the anonymized ranked dataset, which
  // has no real names/tags to search.
  if (rankNames.length === 1) {
    match.displayName = rankNames[0];
  } else if (rankNames.length > 1) {
    match.displayName = { $in: rankNames };
  } else if (names.length === 1) {
    match.displayName = { $regex: `^${escapeRegex(names[0])}`, $options: "i" };
  } else if (names.length > 1) {
    match.displayName = { $regex: `^(${names.map(escapeRegex).join("|")})`, $options: "i" };
  }
  return match;
}

/** Map rank tier keys (e.g. "master") to their displayName labels, dropping
 *  unknown tiers so a bad param can't poison the query. */
function rankTierNames(param: string | undefined): string[] {
  return splitParam(param)
    .map((r) => RANK_DISPLAY_NAME[r.toLowerCase()])
    .filter(Boolean);
}

const TOURNAMENT_KEY_RE = /^[a-z0-9-]{1,80}$/;
const REPLAY_ID_RE = /^[0-9a-f]{24}$/;
/** Most replays one explicit-list export may name (Phase 2 of docs/clip-search.md). */
export const MAX_REPLAY_IDS = 100_000;

/** Valid, de-duplicated replay ids (lowercase hex) from an array or comma list, capped. */
export function replayIdList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const out = new Set<string>();
  for (const x of raw) {
    const id = typeof x === "string" ? x.trim().toLowerCase() : "";
    if (REPLAY_ID_RE.test(id)) out.add(id);
    if (out.size >= MAX_REPLAY_IDS) break;
  }
  return [...out];
}

/**
 * The tournamentKey condition for these keys, usable by the partial index
 * { tournamentKey: 1, startAt: -1 } (partialFilterExpression: tournamentKey is
 * a string): the `$type` makes the index eligible, so it's scanned only for
 * these keys. Every query on tournamentKey should use this.
 */
export function tournamentKeyMatch(keys: string[]): Record<string, unknown> {
  return keys.length === 1 ? { $eq: keys[0], $type: "string" } : { $in: keys, $type: "string" };
}

/** Valid, de-duplicated tournament keys from a comma-joined param. */
export function tournamentKeys(param: string | undefined): string[] {
  return Array.from(new Set(splitParam(param).map((k) => k.toLowerCase()).filter((k) => TOURNAMENT_KEY_RE.test(k))));
}

function prefixMatch(match: Record<string, any>, prefix: string): Record<string, any> {
  const result: any = {};
  for (const [key, value] of Object.entries(match)) {
    result[`${prefix}.${key}`] = value;
  }
  return result;
}

export function buildReplaySearchQuery(params: ReplaySearchParams): Record<string, any> {
  // A clip-search selection is not expressible as one replay query; selecting
  // everything by mistake would be far worse than failing.
  if (params.clipSearch) throw new Error("clip-search selections resolve through clipSearchReplayIds, not a replay query");
  // Exclude junk replays. This used to inline the NOT_JUNK_QUERY predicate, but none
  // of it is indexable, so Mongo had to fetch every candidate doc just to re-check
  // it — ~1.6s of a ~2.5s estimate on a 2M-row filter, to drop 0.5% of rows. It's
  // now materialised on each doc as `usable` (backfillUsable.ts keeps the two in
  // lockstep; crawlWorker tags new imports), which an index can serve directly.
  const notJunk = { usable: true };

  const query: any = {};

  const p1CharIds = splitParam(params.p1CharacterId);
  const p1Codes = splitParam(params.p1ConnectCode);
  const p1Names = splitParam(params.p1DisplayName);
  const p2CharIds = splitParam(params.p2CharacterId);
  const p2Codes = splitParam(params.p2ConnectCode);
  const p2Names = splitParam(params.p2DisplayName);

  // Rank tiers fold into the per-side player match (rank IS the displayName in
  // the ranked dataset), so two-sided rank reuses the same order-independent
  // matchup logic as the p1-vs-p2 player search below.
  const p1Match = buildPlayerMatch(p1CharIds, p1Codes, p1Names, rankTierNames(params.p1Rank));
  const p2Match = buildPlayerMatch(p2CharIds, p2Codes, p2Names, rankTierNames(params.p2Rank));

  const hasP1 = Object.keys(p1Match).length > 0;
  const hasP2 = Object.keys(p2Match).length > 0;
  if (hasP1 && hasP2) {
    // Each side must match a different player, in any of the (up to four) slots.
    // The $all pre-filter can use the players.* indexes; the slot pairs then rule
    // out one player satisfying both sides (e.g. a lone Fox in a Fox-vs-Fox search).
    const slotPairs: Record<string, any>[] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      for (let j = 0; j < MAX_PLAYERS; j++) {
        if (i !== j) {
          slotPairs.push({ ...prefixMatch(p1Match, `players.${i}`), ...prefixMatch(p2Match, `players.${j}`) });
        }
      }
    }
    const charsOnly = (m: Record<string, any>) => Object.keys(m).length === 1 && "characterId" in m;
    if (charsOnly(p1Match) && charsOnly(p2Match)) {
      // A character-vs-character matchup: 1v1s by their indexed pair (charPair),
      // 3–4 player games by the per-slot check below. Same results, but a
      // matchup no longer means checking every game of the commoner character.
      const pairs = new Set<string>();
      for (const a of p1CharIds.map(Number)) for (const b of p2CharIds.map(Number)) pairs.add(a <= b ? `${a}-${b}` : `${b}-${a}`);
      query.$or = [
        { charPair: { $in: [...pairs] } },
        { charPair: "multi", players: { $all: [{ $elemMatch: p1Match }, { $elemMatch: p2Match }] }, $or: slotPairs },
      ];
    } else {
      query.players = { $all: [{ $elemMatch: p1Match }, { $elemMatch: p2Match }] };
      query.$or = slotPairs;
    }
  } else if (hasP1) {
    query.players = { $elemMatch: p1Match };
  } else if (hasP2) {
    query.players = { $elemMatch: p2Match };
  }

  const stageIds = splitParam(params.stageId);
  if (stageIds.length === 1) {
    query.stageId = Number(stageIds[0]);
  } else if (stageIds.length > 1) {
    query.stageId = { $in: stageIds.map(Number) };
  }

  // Replay source (netplay / ranked / tournament). Unknown values are dropped so a
  // bad param can't poison the query; an empty result means "no filter".
  const sources = splitParam(params.source).filter((s) =>
    (REPLAY_SOURCES as string[]).includes(s)
  );
  if (sources.length === 1) {
    query.source = sources[0];
  } else if (sources.length > 1) {
    query.source = { $in: sources };
  }

  const ids = replayIdList(params.replayIds);
  if (ids.length) query._id = { $in: ids.map((id) => new Types.ObjectId(id)) };

  // `$type: "string"` restates the tournament index's partialFilterExpression.
  // MongoDB only narrows a partial index by a field when the query visibly
  // implies that filter; a bare equality doesn't, so it scanned all ~440k
  // tournament-tagged replays (KOTJ #7: 441 ms -> 0 ms). See tournamentKeyMatch.
  const tournaments = tournamentKeys(params.tournament);
  if (tournaments.length) query.tournamentKey = tournamentKeyMatch(tournaments);

  if (params.startDate || params.endDate) {
    query.startAt = {};
    if (params.startDate) {
      const d = new Date(params.startDate);
      if (!isNaN(d.getTime())) query.startAt.$gte = d;
    }
    if (params.endDate) {
      const d = new Date(params.endDate);
      if (!isNaN(d.getTime())) {
        // A plain date is a whole (UTC) day: "through 2024-01-15" includes that day.
        if (DATE_ONLY_RE.test(params.endDate)) {
          query.startAt.$lt = new Date(d.getTime() + DAY_MS);
        } else {
          query.startAt.$lte = d;
        }
      }
    }
    if (Object.keys(query.startAt).length === 0) delete query.startAt;
  }

  return { $and: [notJunk, query] };
}
