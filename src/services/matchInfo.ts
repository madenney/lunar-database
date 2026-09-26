/** Online match context from a replay's game-start block (Slippi 3.14+). */
export interface MatchInfo {
  /** Set/session ID shared by every game of an online set. */
  id: string | null;
  /** "ranked", "unranked", "direct", "teams"… parsed from the ID. */
  mode: string | null;
  gameNumber: number | null;
  tiebreaker: number | null;
}

/** "mode.ranked-2024-…" → "ranked". */
export function matchMode(id: string | null | undefined): string | null {
  const m = /^mode\.([a-z]+)/i.exec(id ?? "");
  return m ? m[1].toLowerCase() : null;
}

type SettingsMatchInfo =
  | { sessionId?: string | null; matchId?: string | null; gameNumber?: number | null; tiebreakerNumber?: number | null }
  | null
  | undefined;

/** Match info from slippi-js settings.matchInfo; every field null when absent. */
export function readMatchInfo(matchInfo: SettingsMatchInfo): MatchInfo {
  const id = matchInfo?.sessionId || matchInfo?.matchId || null;
  return {
    id,
    mode: matchMode(id),
    gameNumber: matchInfo?.gameNumber ?? null,
    tiebreaker: matchInfo?.tiebreakerNumber ?? null,
  };
}
