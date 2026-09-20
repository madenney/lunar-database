import { config } from "../config";
import { DownloadEvent } from "../models/DownloadEvent";

/**
 * Rate-limit issuance of the full-DB (~1.3 TB) presigned download URL.
 *
 * The full-DB bundle is our single biggest egress cost: a handful of pulls per
 * month dwarf all normal traffic, and the worst offenders were one client pulling
 * it 3–4× in a single day (retries of a download too slow to finish). This caps
 * how many full-DB URLs we hand a given caller per rolling window.
 *
 * Identity:
 *   • clientId present → counted against the persistent DownloadEvent log
 *     (survives restarts; already indexed by {clientId, createdAt}). This is the
 *     real observed case — the frontend always sends an X-Client-Id.
 *   • no clientId (anonymous / direct API) → an in-memory per-IP counter. We
 *     deliberately do NOT persist IPs (privacy); a restart resets these, which is
 *     an acceptable backstop for the secondary case.
 *
 * `check` only READS. The caller records a successful issuance separately —
 * clientId pulls via the existing DownloadEvent.create, anonymous pulls via
 * recordAnonymousFullDbDownload — so a request that fails after the check (e.g. a
 * B2 cap 503) doesn't consume a slot.
 */

export interface FullDbLimitResult {
  allowed: boolean;
  /** Seconds until a slot frees up (0 when allowed). */
  retryAfterSeconds: number;
}

// ip -> ascending timestamps (ms) of issued full-DB URLs, within the window.
const anonHits = new Map<string, number[]>();

function windowMs(): number {
  return config.fullDbWindowHours * 60 * 60 * 1000;
}

/** Read-only limit check. Does not consume a slot. */
export async function checkFullDbDownloadLimit(
  clientId: string | null | undefined,
  ipKey: string
): Promise<FullDbLimitResult> {
  const max = config.fullDbMaxPerWindow;
  if (max <= 0) return { allowed: true, retryAfterSeconds: 0 }; // disabled

  const now = Date.now();
  const win = windowMs();
  const cutoff = new Date(now - win);

  if (clientId) {
    // Oldest-first, capped at `max` — enough to know if we're at the limit and
    // when the oldest in-window pull ages out.
    const recent = await DownloadEvent.find({
      type: "full_db",
      clientId,
      createdAt: { $gte: cutoff },
    })
      .select("createdAt")
      .sort({ createdAt: 1 })
      .limit(max)
      .lean();

    if (recent.length < max) return { allowed: true, retryAfterSeconds: 0 };
    const oldest = recent[0].createdAt.getTime();
    return { allowed: false, retryAfterSeconds: retryAfter(oldest, win, now) };
  }

  // Anonymous: in-memory per-IP.
  const hits = (anonHits.get(ipKey) || []).filter((t) => t > now - win);
  if (hits.length > 0) anonHits.set(ipKey, hits);
  else anonHits.delete(ipKey);

  if (hits.length < max) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: retryAfter(hits[0], win, now) };
}

/** Record a successful anonymous full-DB issuance (call only when no clientId). */
export function recordAnonymousFullDbDownload(ipKey: string): void {
  if (config.fullDbMaxPerWindow <= 0) return;
  const now = Date.now();
  const hits = (anonHits.get(ipKey) || []).filter((t) => t > now - windowMs());
  hits.push(now);
  anonHits.set(ipKey, hits);
  if (anonHits.size > 5000) pruneAnon(now - windowMs());
}

function retryAfter(oldestMs: number, win: number, now: number): number {
  return Math.max(1, Math.ceil((oldestMs + win - now) / 1000));
}

function pruneAnon(cutoffMs: number): void {
  for (const [k, arr] of anonHits) {
    const kept = arr.filter((t) => t > cutoffMs);
    if (kept.length) anonHits.set(k, kept);
    else anonHits.delete(k);
  }
}

/** Human-friendly "3h 20m" / "45m" / "30s" for the client-facing message. */
export function formatRetryAfter(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}
