/**
 * start.gg linkage for online sets (scripts/startggSync.ts).
 *
 * start.gg publishes each entrant's Slippi connect code (connectedAccounts), set
 * start/finish times and per-game winners. An online set is matched to archive
 * games by the unordered connect-code pair inside the set's time window; see
 * matchSet for the acceptance rule. Offline sets come with their start.gg IDs
 * (context.json, scripts/buildSets.ts) and need no matching.
 */

const ENDPOINT = "https://api.start.gg/gql/alpha";

/** Minimal GraphQL client: one request at a time, spaced under start.gg's 80/min limit, with retries. */
export class StartggClient {
  private last = 0;
  requests = 0;

  constructor(private token: string, private spacingMs = 800) {}

  async query<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      const wait = this.spacingMs - (Date.now() - this.last);
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.requests++;
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(60_000),
        });
        const body: any = await res.json().catch(() => ({}));
        if (res.status === 429 || res.status >= 500 || /rate limit/i.test(body?.message ?? "")) {
          lastErr = new Error(`start.gg HTTP ${res.status}`);
          await sleep(Math.min(60_000, 5000 * 2 ** attempt));
          continue;
        }
        if (res.status === 401 || res.status === 403) throw new FatalStartggError(`start.gg HTTP ${res.status}: check STARTGG_TOKEN`);
        if (body.errors) throw new StartggQueryError(JSON.stringify(body.errors).slice(0, 500));
        return body.data as T;
      } catch (err) {
        if (err instanceof FatalStartggError || err instanceof StartggQueryError) throw err;
        lastErr = err; // network error or timeout
        await sleep(Math.min(60_000, 5000 * 2 ** attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("start.gg request failed");
  }
}

export class FatalStartggError extends Error {}
export class StartggQueryError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connect codes are stored uppercase in the archive; start.gg keeps what the player typed. */
export function normCode(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const c = code.trim().toUpperCase();
  return /^[A-Z0-9]{1,8}#\d{1,4}$/.test(c) ? c : null;
}

/** A start.gg set as the sync queries it (times in unix seconds). */
export interface SggSet {
  id: number;
  startedAt: number | null;
  completedAt: number | null;
  fullRoundText: string | null;
  winnerId: number | null;
  games: { orderNum: number; winnerId: number | null }[] | null;
  slots: {
    entrant: { id: number; participants: { gamerTag: string | null; prefix: string | null }[] } | null;
    standing: { stats: { score: { value: number | null } | null } | null } | null;
  }[];
}

/** An archive game that could belong to a set: one recording, with its winner if decided. */
export interface CandidateGame {
  replayId: string;
  /** Game start, unix seconds. */
  t: number;
  /** Connect code of each player, by playerIndex. */
  codes: Record<number, string>;
  winnerIndex: number | null;
  /** Same fingerprint = the same game recorded twice (e.g. by both players). */
  fingerprint: string | null;
}

export interface SetMatch {
  /** Chosen recordings in play order, with the index (into the set's two sides) of each game's winner. */
  games: { replayId: string; n: number; winner: number }[];
  method: "games" | "score";
}

/** Slack before a set's recorded start: players often start game 1 a little before the TO marks the set started. */
export const START_SLACK_S = 120;

/**
 * Match a start.gg set to archive games. `codes` are the two sides' connect codes
 * (slot order); `candidates` are games between those two codes near the set's
 * time window, in any order.
 *
 * Accepted only when the evidence agrees exactly: the set's last N decided games
 * (one recording per game, started between startedAt - 2 min and completedAt)
 * must have the same winners in the same order as start.gg's reported games, or,
 * when start.gg has only the score, the same win counts per side.
 */
export function matchSet(set: SggSet, codes: [string, string], candidates: CandidateGame[]): SetMatch | null {
  if (!set.startedAt || !set.completedAt || set.slots.length !== 2) return null;
  const scores = set.slots.map((s) => s.standing?.stats?.score?.value ?? null);
  if (scores.some((v) => v == null || v < 0)) return null; // DQ or no score
  const reported = (set.games ?? []).filter((g) => g.winnerId != null).sort((a, b) => a.orderNum - b.orderNum);
  const entrantIds = set.slots.map((s) => s.entrant?.id);
  const expected = reported.length ? reported.length : (scores[0] as number) + (scores[1] as number);
  if (expected < 1) return null;

  const seen = new Set<string>();
  const decided: { replayId: string; winner: number }[] = [];
  for (const g of [...candidates].sort((a, b) => a.t - b.t)) {
    if (g.t < set.startedAt - START_SLACK_S || g.t > set.completedAt) continue;
    const key = g.fingerprint ?? g.replayId;
    if (seen.has(key)) continue;
    seen.add(key);
    if (g.winnerIndex == null) continue;
    const winnerCode = g.codes[g.winnerIndex];
    const side = winnerCode === codes[0] ? 0 : winnerCode === codes[1] ? 1 : -1;
    if (side < 0) continue;
    decided.push({ replayId: g.replayId, winner: side });
  }
  if (decided.length < expected) return null;
  const inSet = decided.slice(-expected);

  let method: SetMatch["method"];
  if (reported.length) {
    const theirs = reported.map((g) => entrantIds.indexOf(g.winnerId ?? undefined));
    if (theirs.some((w) => w < 0) || inSet.some((g, i) => g.winner !== theirs[i])) return null;
    method = "games";
  } else {
    const wins = [0, 1].map((k) => inSet.filter((g) => g.winner === k).length);
    if (wins[0] !== scores[0] || wins[1] !== scores[1]) return null;
    method = "score";
  }
  return { games: inSet.map((g, i) => ({ replayId: g.replayId, n: i + 1, winner: g.winner })), method };
}
