import fs from "fs";
import path from "path";
import zlib from "zlib";
import { config } from "../config";
import type { IGameStats } from "../models/GameStats";
import type { ExtractorName } from "./gameStats";

/**
 * A game's events, read from the stats run's detail files: each extractor with
 * events wrote one gzip JSON-lines file per shard, and the game's record names
 * the shard and version (`shards.<extractor>`, `extractors.<extractor>`).
 *
 * A shard file holds ~5,000 games, so recently read files are kept decompressed
 * and indexed by replay ID; neighbouring games in a result page usually share one.
 */

const EVENT_EXTRACTORS: ExtractorName[] = ["core", "clipper", "techLedge"];
const CACHE_FILES = 4;
const cache = new Map<string, Map<string, string>>();

function readShardFile(file: string): Map<string, string> {
  const hit = cache.get(file);
  if (hit) {
    cache.delete(file);
    cache.set(file, hit); // most recently used last
    return hit;
  }
  const byReplay = new Map<string, string>();
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
  for (const line of text.split("\n")) {
    // Lines start {"r":"<24-hex replay id>",…
    if (line.length > 32) byReplay.set(line.slice(6, 30), line);
  }
  cache.set(file, byReplay);
  while (cache.size > CACHE_FILES) cache.delete(cache.keys().next().value!);
  return byReplay;
}

export function detailFile(dir: string, extractor: string, version: number, shard: string): string {
  return path.join(dir, extractor, `v${version}`, `${shard}.jsonl.gz`);
}

/** Events per extractor for one game, or null for extractors whose file is missing. */
export function loadGameEvents(
  stats: Pick<IGameStats, "replayId" | "extractors" | "shards">,
  dir = config.statsDetailDir
): Partial<Record<ExtractorName, Record<string, unknown> | null>> {
  const out: Partial<Record<ExtractorName, Record<string, unknown> | null>> = {};
  if (!dir) return out;
  const id = String(stats.replayId);
  for (const e of EVENT_EXTRACTORS) {
    const version = stats.extractors?.[e];
    const shard = stats.shards?.[e];
    if (version == null || !shard) continue;
    try {
      const line = readShardFile(detailFile(dir, e, version, shard)).get(id);
      if (!line) {
        out[e] = null;
        continue;
      }
      const { r: _r, ...events } = JSON.parse(line);
      out[e] = events;
    } catch {
      out[e] = null; // file not readable here (e.g. not yet published)
    }
  }
  return out;
}

export function clearGameDetailCache(): void {
  cache.clear();
}
