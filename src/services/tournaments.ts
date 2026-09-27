import seriesConfig from "../config/tournamentSeries.json";

/**
 * Tournament identity for archive replays (scripts/buildTournaments.ts).
 *
 * A game belongs to a tournament by, in order: its set's start.gg identity
 * (context.json from set exports), its set's Jungle metadata (set.json), or its
 * folder under tournament/ using config/tournamentSeries.json (series folders hold
 * many events; a plain top-level folder is one event).
 */

export interface TournamentRef {
  /** URL-safe, stable key, e.g. "midlane-melee-177", "kotj-7". */
  key: string;
  name: string;
  /** false for folders that aren't tournaments (friendlies, unknown). */
  listed: boolean;
  startggSlug?: string | null;
}

type SeriesRule = { level?: number; match?: string; rename?: [string, string] };
const SERIES = seriesConfig.series as unknown as Record<string, SeriesRule>;
const UNLISTED = new Set(seriesConfig.unlisted.map((s) => s.toLowerCase()));

export function slugify(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "tournament"
  );
}

/** Tournament of a replay from its archive path (tournament/<...>), or null for other sources. */
export function tournamentFromPath(filePath: string): TournamentRef | null {
  const parts = filePath.split("/");
  if (parts[0] !== "tournament" || parts.length < 3) return null;
  const folders = parts.slice(1, -1); // [top, ..., containing folder]
  const top = folders[0];
  if (UNLISTED.has(top.toLowerCase())) return { key: slugify(top), name: top, listed: false };
  const rule = SERIES[top];
  if (!rule) return { key: slugify(top), name: top, listed: true };

  let event: string | undefined;
  if (rule.match) {
    const re = new RegExp(rule.match, "i");
    event = folders.slice(1).find((f) => re.test(f));
  } else if (rule.level && rule.level >= 2) {
    event = folders[rule.level - 1];
  }
  if (!event) return { key: slugify(top), name: top, listed: false }; // loose files in a series folder
  if (rule.rename) {
    const renamed = event.replace(new RegExp(rule.rename[0], "i"), rule.rename[1]);
    if (renamed !== event) return { key: slugify(renamed), name: renamed, listed: true };
  }
  const name = event.toLowerCase().includes(top.toLowerCase()) ? event : `${top} ${event}`;
  return { key: slugify(name), name, listed: true };
}

/** "tournament/midlane-melee-177/event/melee-singles" -> "midlane-melee-177". */
export function startggTournamentSlug(eventSlug: string | null | undefined): string | null {
  const m = /^tournament\/([^/]+)/.exec(eventSlug ?? "");
  return m ? m[1] : null;
}

/** Tournament from a set export's start.gg context. Names lack edition numbers, so the slug's is added. */
export function tournamentFromStartgg(name: string | null | undefined, eventSlug: string | null | undefined): TournamentRef | null {
  const slug = startggTournamentSlug(eventSlug);
  if (!slug) return null;
  let display = (name ?? "").trim() || slug.replace(/-/g, " ");
  const edition = /-(\d+)$/.exec(slug)?.[1];
  if (edition && !new RegExp(`\\b${edition}\\b`).test(display)) display = `${display} ${edition}`;
  return { key: slug, name: display, listed: true, startggSlug: slug };
}
