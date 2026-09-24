import { IJobFilter } from "../models/Job";
import { REPLAY_SOURCES } from "../models/Replay";
import { MAX_LIST_VALUES, RANK_KEYS } from "./replaySearchQuery";

const MAX_FILTER_STRING_LEN = 100;
/** Largest byte budget a job may request. The estimator relies on this bound. */
export const MAX_SIZE_MB = 10000;

function safeString(val: unknown, maxLen = MAX_FILTER_STRING_LEN): string | undefined {
  if (val == null) return undefined;
  if (typeof val !== "string" && typeof val !== "number") return undefined;
  return String(val).slice(0, maxLen);
}

/** Normalise a comma-joined list: trim, drop empties, cap each value and the count. */
function safeList(val: unknown): string | undefined {
  const raw = safeString(val, MAX_FILTER_STRING_LEN * MAX_LIST_VALUES * 2);
  if (!raw) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim().slice(0, MAX_FILTER_STRING_LEN))
    .filter(Boolean)
    .slice(0, MAX_LIST_VALUES);
  return items.length > 0 ? items.join(",") : undefined;
}

/**
 * Parse a client filter (estimate, job creation, admin re-run) into the stored
 * job filter. Estimate and create both go through here so they select the same
 * replays.
 */
export function parseFilter(body: Record<string, any>): IJobFilter {
  const filter: IJobFilter = {};
  const p1cc = safeList(body.p1ConnectCode); if (p1cc) filter.p1ConnectCode = p1cc;
  const p1ci = safeList(body.p1CharacterId); if (p1ci) filter.p1CharacterId = p1ci;
  const p1dn = safeList(body.p1DisplayName); if (p1dn) filter.p1DisplayName = p1dn;
  const p2cc = safeList(body.p2ConnectCode); if (p2cc) filter.p2ConnectCode = p2cc;
  const p2ci = safeList(body.p2CharacterId); if (p2ci) filter.p2CharacterId = p2ci;
  const p2dn = safeList(body.p2DisplayName); if (p2dn) filter.p2DisplayName = p2dn;
  const sid = safeList(body.stageId); if (sid) filter.stageId = sid;
  const sd = safeString(body.startDate); if (sd) filter.startDate = sd;
  const ed = safeString(body.endDate); if (ed) filter.endDate = ed;
  // Replay source: keep only known values. Selecting every source is the same as
  // no filter, so drop it — otherwise it would satisfy the "at least one filter"
  // guard below and let a client queue a whole-database job.
  const rawSources = safeString(body.source);
  if (rawSources) {
    const picked = rawSources
      .split(",")
      .map((s) => s.trim())
      .filter((s) => (REPLAY_SOURCES as string[]).includes(s));
    const unique = Array.from(new Set(picked));
    if (unique.length > 0 && unique.length < REPLAY_SOURCES.length) {
      filter.source = unique.join(",");
    }
  }
  // Rank tiers per side (ranked dataset only). Keep only known tiers; all-tiers is
  // the same as no rank filter for that side, so drop it (as with source).
  const cleanRank = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    const unique = Array.from(
      new Set(
        raw
          .split(",")
          .map((r) => r.trim().toLowerCase())
          .filter((r) => (RANK_KEYS as readonly string[]).includes(r)),
      ),
    );
    return unique.length > 0 && unique.length < RANK_KEYS.length ? unique.join(",") : undefined;
  };
  const p1Rank = cleanRank(safeString(body.p1Rank));
  if (p1Rank) filter.p1Rank = p1Rank;
  const p2Rank = cleanRank(safeString(body.p2Rank));
  if (p2Rank) filter.p2Rank = p2Rank;
  if (body.maxFiles != null) {
    const n = Number(body.maxFiles);
    if (Number.isFinite(n) && n >= 1) filter.maxFiles = Math.floor(n);
  }
  if (body.maxSizeMb != null) {
    const n = Number(body.maxSizeMb);
    if (Number.isFinite(n) && n > 0) filter.maxSizeMb = Math.min(n, MAX_SIZE_MB);
  }
  const srt = safeString(body.sort); if (srt) filter.sort = srt;
  return filter;
}

/** Whether a parsed filter narrows the replays, and whether it sets a limit. */
export function hasFilterOrLimit(filter: IJobFilter): { hasFilter: boolean; hasLimit: boolean } {
  const hasFilter = Object.keys(filter).some((k) => k !== "maxFiles" && k !== "maxSizeMb" && k !== "sort");
  const hasLimit = filter.maxFiles != null || filter.maxSizeMb != null;
  return { hasFilter, hasLimit };
}
