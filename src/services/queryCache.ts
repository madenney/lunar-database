/**
 * Cache for expensive, slowly-changing query results: match counts and size
 * estimates. A page of search results costs a few ms, but counting or summing
 * a broad filter (every Fox game) scans ~1.5M index entries (~1.7 s of MongoDB
 * CPU). At launch thousands of people ask for the same popular filters, so:
 *
 *  - results are kept for a while (new replays only arrive with a crawl);
 *  - identical requests in flight share one query;
 *  - at most `maxHeavy` such queries run at once, so a burst queues instead of
 *    thrashing MongoDB (load test: >20 concurrent heavy queries = timeouts).
 */
import crypto from "crypto";
import { config } from "../config";

type Entry<T> = { at: number; value: T };

export class QueryCache {
  private entries = new Map<string, Entry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();
  private active = 0;
  private waiting: (() => void)[] = [];
  hits = 0;
  misses = 0;

  /** `caching` is off under test by default, so other tests always read fresh data. */
  constructor(
    private ttlMs: number,
    private maxEntries: number,
    private maxHeavy: number,
    private caching = process.env.NODE_ENV !== "test",
  ) {}

  /** The cached value for `key`, computing it with `fn` (under the concurrency limit) on a miss. */
  async get<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.caching) {
      const hit = this.entries.get(key);
      if (hit && Date.now() - hit.at < this.ttlMs) {
        this.hits++;
        // Refresh recency for the LRU order.
        this.entries.delete(key);
        this.entries.set(key, hit);
        return hit.value as T;
      }
      const pending = this.inflight.get(key);
      if (pending) return pending as Promise<T>;
    }
    this.misses++;
    const run = this.limit(fn).then((value) => {
      if (this.caching) {
        this.entries.set(key, { at: Date.now(), value });
        while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
      }
      return value;
    });
    if (this.caching) {
      this.inflight.set(key, run);
      run.finally(() => this.inflight.delete(key)).catch(() => {});
    }
    return run;
  }

  /** Run `fn` when fewer than maxHeavy heavy queries are running. */
  private async limit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxHeavy) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  clear() {
    this.entries.clear();
  }

  stats() {
    return { entries: this.entries.size, hits: this.hits, misses: this.misses, active: this.active, waiting: this.waiting.length };
  }
}

/** Stable cache key for a params object: sorted keys, empty values dropped. */
export function paramsKey(prefix: string, params: Record<string, unknown>): string {
  const clean = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map((k) => [k, params[k]]);
  const json = JSON.stringify(clean);
  // Explicit id lists can be long: hash big keys so the cache stays small.
  return `${prefix}:${json.length > 512 ? crypto.createHash("sha1").update(json).digest("hex") : json}`;
}

/** Match counts and size estimates (shared by search, estimate and job creation). */
export const heavyQueries = new QueryCache(config.queryCacheSeconds * 1000, 20_000, config.queryMaxHeavy);
