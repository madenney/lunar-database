import { SlippiGame } from "@slippi/slippi-js/node";
import { stages, characters } from "@slippi/slippi-js";
import { IReplayPlayer } from "../models/Replay";
import { readMatchInfo } from "./matchInfo";

/** Slippi replays exist from 2018; a console with a wrong clock can say 1982 or 2034. */
export const EARLIEST_REPLAY_DATE = new Date("2018-01-01T00:00:00Z");

/**
 * A replay's recorded start time if it's possible (from 2018 up to a day past
 * `now`), else null. Recording devices with wrong clocks produce the rest.
 */
export function plausibleStartAt(d: Date | null, now = new Date()): Date | null {
  if (!d || isNaN(d.getTime())) return null;
  if (d < EARLIEST_REPLAY_DATE || d.getTime() > now.getTime() + 24 * 3600 * 1000) return null;
  return d;
}

export interface ParsedReplay {
  stageId: number | null;
  stageName: string | null;
  /** When the game was played; null when unknown or the recorded date is impossible. */
  startAt: Date | null;
  /** The recorded date when it was impossible (and so not used as startAt). */
  startAtRaw: Date | null;
  duration: number | null;
  players: IReplayPlayer[];
  winner: number | null;
  /** Online set/session ID (Slippi 3.14+), shared by every game of a set. */
  matchId: string | null;
  gameNumber: number | null;
  tiebreaker: number | null;
  /** "ranked", "unranked", "direct", "teams"… from the match ID. */
  mode: string | null;
}

export function parseSlpFile(filePath: string): ParsedReplay {
  const game = new SlippiGame(filePath);
  const settings = game.getSettings();
  const metadata = game.getMetadata();

  const stageId = settings?.stageId ?? null;
  let stageName: string | null = null;
  if (stageId != null) {
    try {
      stageName = stages.getStageName(stageId);
    } catch {
      console.warn(`Unknown stageId: ${stageId}`);
      stageName = null;
    }
  }

  const players: IReplayPlayer[] = (settings?.players ?? []).map((p) => {
    let characterName: string | null = null;
    if (p.characterId != null) {
      try {
        characterName = characters.getCharacterName(p.characterId);
      } catch {
        console.warn(`Unknown characterId: ${p.characterId}`);
        characterName = null;
      }
    }
    return {
      playerIndex: p.playerIndex,
      connectCode: p.connectCode || null,
      displayName: p.displayName || null,
      tag: p.nametag || null,
      characterId: p.characterId ?? null,
      characterName,
    };
  });

  let recorded: Date | null = null;
  if (metadata?.startAt) {
    const d = new Date(metadata.startAt);
    if (!isNaN(d.getTime())) recorded = d;
  }
  const startAt = plausibleStartAt(recorded);
  const startAtRaw = recorded && !startAt ? recorded : null;

  const duration = metadata?.lastFrame ?? null;

  const match = readMatchInfo(settings?.matchInfo);

  return {
    stageId,
    stageName,
    startAt,
    startAtRaw,
    duration,
    players,
    winner: null,
    matchId: match.id,
    gameNumber: match.gameNumber,
    tiebreaker: match.tiebreaker,
    mode: match.mode,
  };
}
