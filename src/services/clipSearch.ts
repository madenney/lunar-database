/**
 * Clip search parameters (docs/clip-search.md): shared by POST /api/clips and
 * clip-search exports (a bulk download of the games behind a clip search).
 */
import mongoose from "mongoose";
import { REPLAY_SOURCES } from "../models/Replay";

export const CLIP_TYPES = ["combo", "edgeguard", "quitout"] as const;
export const CLIP_COUNT_CAP = 10_000;
const MAX_VALUES = 20;
const MAX_LIMIT = 100;
const MAX_PAGE = 400;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Z0-9]{1,8}#\d{1,4}$/;

export interface ClipSearch {
  type: (typeof CLIP_TYPES)[number];
  filter: Record<string, unknown>;
  sort: Record<string, 1 | -1>;
  page: number;
  limit: number;
}

function list(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" || typeof v === "number" ? String(v).split(",") : [];
  return raw.map((x) => String(x).trim()).filter(Boolean).slice(0, MAX_VALUES);
}
const ints = (v: unknown) => [...new Set(list(v).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 1000))];
const codes = (v: unknown) => [...new Set(list(v).map((c) => c.toUpperCase()).filter((c) => CODE_RE.test(c)))];
const oneOrIn = <T>(xs: T[]) => (xs.length === 1 ? xs[0] : { $in: xs });
const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Validate a search body into a MongoDB filter and sort, or return an error message. */
export function parseClipSearch(body: Record<string, unknown>): ClipSearch | { error: string } {
  const type = body.type;
  if (typeof type !== "string" || !(CLIP_TYPES as readonly string[]).includes(type)) {
    return { error: `type must be one of ${CLIP_TYPES.join(", ")}` };
  }
  const filter: Record<string, unknown> = { type };
  const attChars = ints(body.attackerCharacterId);
  const vicChars = ints(body.victimCharacterId);
  const attCodes = codes(body.attackerConnectCode);
  const vicCodes = codes(body.victimConnectCode);
  if (attChars.length) filter["attacker.characterId"] = oneOrIn(attChars);
  if (vicChars.length) filter["victim.characterId"] = oneOrIn(vicChars);
  if (attCodes.length) filter["attacker.connectCode"] = oneOrIn(attCodes);
  if (vicCodes.length) filter["victim.connectCode"] = oneOrIn(vicCodes);

  const stages = ints(body.stageId);
  if (stages.length) filter.stageId = oneOrIn(stages);
  const sources = list(body.source).filter((s) => (REPLAY_SOURCES as readonly string[]).includes(s));
  if (sources.length && sources.length < REPLAY_SOURCES.length) filter.source = oneOrIn(sources);

  const startAt: Record<string, Date> = {};
  if (typeof body.startDate === "string" && DATE_RE.test(body.startDate)) startAt.$gte = new Date(`${body.startDate}T00:00:00Z`);
  if (typeof body.endDate === "string" && DATE_RE.test(body.endDate)) startAt.$lt = new Date(new Date(`${body.endDate}T00:00:00Z`).getTime() + 86_400_000);
  if (Object.keys(startAt).length) filter.startAt = startAt;

  const minDamage = num(body.minDamage);
  if (minDamage != null && minDamage > 0 && type !== "edgeguard") filter.damage = { $gte: minDamage };
  const minMoves = num(body.minMoves);
  if (minMoves != null && minMoves > 0) filter.moves = { $gte: Math.floor(minMoves) };
  if (body.zeroToDeath === true || body.zeroToDeath === "true") {
    if (type === "combo") Object.assign(filter, { didKill: true, startPercent: 0 });
  } else if ((body.killOnly === true || body.killOnly === "true") && type === "combo") {
    filter.didKill = true;
  }

  // Hidden unless asked for: wobbles and one-move infinites (services/clips.ts isInfinite).
  if (!(body.includeInfinites === true || body.includeInfinites === "true")) filter.infinite = { $ne: true };

  // Newest first by default (user decision 2026-09-30); "best" = most damage / best score.
  const sortName = body.sort === "best" || body.sort === "oldest" ? body.sort : "newest";
  const sort: Record<string, 1 | -1> = sortName === "best" ? { rank: -1 } : { startAt: sortName === "newest" ? -1 : 1 };
  // Oldest-first would otherwise open with every undated (ranked) clip.
  if (sortName === "oldest") filter.startAt = { ...(filter.startAt as object), $ne: null };

  const page = Math.max(1, Math.min(MAX_PAGE, Math.floor(num(body.page) ?? 1)));
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(num(body.limit) ?? 25)));
  return { type: type as ClipSearch["type"], filter, sort, page, limit };
}


// ------------------------------------------------------------------ exports

/** The fields that decide which clips (and so which games) a search selects. */
const SELECTING_FIELDS = [
  "type", "attackerCharacterId", "victimCharacterId", "attackerConnectCode", "victimConnectCode",
  "stageId", "source", "startDate", "endDate", "minDamage", "minMoves", "killOnly", "zeroToDeath", "includeInfinites",
] as const;

const LIST_FIELDS = new Set(["attackerCharacterId", "victimCharacterId", "attackerConnectCode", "victimConnectCode", "stageId", "source"]);

/**
 * A clip search as a canonical string (sorted keys, only the fields that select
 * clips, primitives or lists), for storing on a job and as its reuse key. Null
 * when the search is invalid.
 */
export function canonicalClipSearch(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const src = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of [...SELECTING_FIELDS].sort()) {
    const v = src[k];
    if (v === undefined || v === null || v === "" || v === false) continue;
    const ok = (x: unknown) => ["string", "number", "boolean"].includes(typeof x);
    if (LIST_FIELDS.has(k)) {
      // "2", ["2"] and [2] are the same search: always a sorted array of strings.
      const items = Array.isArray(v) ? v : ok(v) ? String(v).split(",") : null;
      if (!items || items.length > MAX_VALUES || !items.every(ok)) return null;
      const clean = [...new Set(items.map((x) => String(x).trim()).filter(Boolean))].sort();
      if (clean.length) out[k] = clean;
    } else if (Array.isArray(v)) {
      return null;
    } else if (ok(v)) {
      out[k] = v;
    } else {
      return null;
    }
  }
  return "error" in parseClipSearch(out) ? null : JSON.stringify(out);
}

/**
 * The distinct replays behind a clip search, as hex ids, in batches (a broad
 * search can name millions of clips). Uses the clips indexes like search does.
 */
export async function* clipSearchReplayIds(canonical: string, batchSize = 20_000): AsyncGenerator<string[]> {
  const parsed = parseClipSearch(JSON.parse(canonical));
  if ("error" in parsed) throw new Error(`Invalid clip search: ${parsed.error}`);
  const cursor = mongoose.connection
    .collection("clips")
    .aggregate([{ $match: parsed.filter }, { $group: { _id: "$replayId" } }], { allowDiskUse: true, maxTimeMS: 300_000 })
    .batchSize(batchSize);
  let batch: string[] = [];
  for await (const doc of cursor) {
    batch.push(String(doc._id));
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}
