import { SlippiGame } from "@slippi/slippi-js/node";
import { stages, characters } from "@slippi/slippi-js";
import { IPlayer } from "../models/Replay";

export interface ParsedReplay {
  stageId: number | null;
  stageName: string | null;
  startAt: Date | null;
  duration: number | null;
  players: IPlayer[];
  winner: number | null;
}

export function parseSlpFile(filePath: string): ParsedReplay {
  const game = new SlippiGame(filePath);
  const settings = game.getSettings();
  const metadata = game.getMetadata();
  const gameEnd = game.getGameEnd();

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

  const players: IPlayer[] = (settings?.players ?? []).map((p) => {
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

  let startAt: Date | null = null;
  if (metadata?.startAt) {
    const d = new Date(metadata.startAt);
    if (!isNaN(d.getTime())) startAt = d;
  }

  const duration = metadata?.lastFrame ?? null;

  let winner: number | null = null;
  if (gameEnd?.placements) {
    const first = gameEnd.placements.find((p) => p.position === 0);
    if (first) winner = first.playerIndex;
  }

  return { stageId, stageName, startAt, duration, players, winner };
}
