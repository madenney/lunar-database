/**
 * Builds a MongoDB query from replay search parameters.
 * Shared by GET /api/replays and POST /api/replays/estimate.
 */

export interface ReplaySearchParams {
  p1CharacterId?: string;
  p1ConnectCode?: string;
  p1DisplayName?: string;
  p2CharacterId?: string;
  p2ConnectCode?: string;
  p2DisplayName?: string;
  stageId?: string;
  startDate?: string;
  endDate?: string;
  maxFiles?: number;
  maxSizeMb?: number;
  /** "field:dir" e.g. "startAt:-1". Used so a limited selection (maxFiles) picks
   *  the same first-N rows the UI shows in that sort order. */
  sort?: string;
}

const SORT_ALLOWLIST = ["startAt", "indexedAt", "duration"];

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
 * Build the search query AND its sort object together, for endpoints that need a
 * limited result set in sort order (estimate + download worker). Mirrors the list
 * endpoint: when sorting by ascending date, null/undated replays are excluded so
 * the "oldest N" are genuinely the oldest dated games (Mongo sorts nulls first).
 */
export function buildSortedQuery(
  params: ReplaySearchParams
): { query: Record<string, any>; sortObj: Record<string, 1 | -1> } {
  const sortObj = parseSort(params.sort);
  let query = buildReplaySearchQuery(params);
  if (sortObj.startAt === 1) {
    query = { $and: [query, { startAt: { $ne: null } }] };
  }
  return { query, sortObj };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function splitParam(v: string | undefined, max = 20): string[] {
  return v ? v.split(",").filter(Boolean).slice(0, max) : [];
}

function buildPlayerMatch(charIds: string[], codes: string[], names: string[]): Record<string, any> {
  const match: any = {};
  if (charIds.length === 1) match.characterId = Number(charIds[0]);
  else if (charIds.length > 1) match.characterId = { $in: charIds.map(Number) };
  if (codes.length === 1) match.connectCode = codes[0];
  else if (codes.length > 1) match.connectCode = { $in: codes };
  if (names.length === 1) {
    match.displayName = { $regex: `^${escapeRegex(names[0])}`, $options: "i" };
  } else if (names.length > 1) {
    match.displayName = { $regex: `^(${names.map(escapeRegex).join("|")})`, $options: "i" };
  }
  return match;
}

function prefixMatch(match: Record<string, any>, prefix: string): Record<string, any> {
  const result: any = {};
  for (const [key, value] of Object.entries(match)) {
    result[`${prefix}.${key}`] = value;
  }
  return result;
}

export function buildReplaySearchQuery(params: ReplaySearchParams): Record<string, any> {
  // Exclude junk replays: must have a known stage or at least one known character,
  // and must not be a zero-length / aborted game. A `duration` (Slippi
  // metadata.lastFrame) of 0 or less means the game ended at or before the "GO!"
  // frame — i.e. quit during the countdown, handwarmer, or a truncated file. We
  // exclude those but KEEP null/missing duration (genuinely unknown length, but
  // possibly a valid game).
  const notJunk = {
    $or: [
      { stageId: { $ne: null } },
      { "players.characterId": { $ne: null } },
    ],
    "players.0": { $exists: true },
    duration: { $not: { $lte: 0 } },
  };

  const query: any = {};

  const p1CharIds = splitParam(params.p1CharacterId);
  const p1Codes = splitParam(params.p1ConnectCode);
  const p1Names = splitParam(params.p1DisplayName);
  const p2CharIds = splitParam(params.p2CharacterId);
  const p2Codes = splitParam(params.p2ConnectCode);
  const p2Names = splitParam(params.p2DisplayName);

  const p1Match = buildPlayerMatch(p1CharIds, p1Codes, p1Names);
  const p2Match = buildPlayerMatch(p2CharIds, p2Codes, p2Names);

  const hasP1 = Object.keys(p1Match).length > 0;
  const hasP2 = Object.keys(p2Match).length > 0;
  if (hasP1 && hasP2) {
    query.$or = [
      { ...prefixMatch(p1Match, "players.0"), ...prefixMatch(p2Match, "players.1") },
      { ...prefixMatch(p1Match, "players.1"), ...prefixMatch(p2Match, "players.0") },
    ];
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

  if (params.startDate || params.endDate) {
    query.startAt = {};
    if (params.startDate) {
      const d = new Date(params.startDate);
      if (!isNaN(d.getTime())) query.startAt.$gte = d;
    }
    if (params.endDate) {
      const d = new Date(params.endDate);
      if (!isNaN(d.getTime())) query.startAt.$lte = d;
    }
    if (Object.keys(query.startAt).length === 0) delete query.startAt;
  }

  return { $and: [notJunk, query] };
}
