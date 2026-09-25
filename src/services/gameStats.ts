import { SlippiGame } from "@slippi/slippi-js/node";

/** Bump when the extracted shape or rules change; the runner re-extracts older rows. */
export const STATS_VERSION = 1;

export type WinMethod = "stocks" | "time" | "lras";

/** GameEndMethod values from slippi-js. */
const END_TIME = 1;
const END_NO_CONTEST = 7;

/** A quit-out (LRAS) this early is a restart, not a forfeit. */
const RESTART_FRAMES = 30 * 60;

export interface WinnerInput {
  players: { playerIndex: number; startStocks: number }[];
  stocks: { playerIndex: number; endFrame?: number | null; currentPercent?: number | null }[];
  lastFrame: number;
  endMethod: number | null;
  lrasInitiator: number | null;
}

/**
 * Decide a 1v1 game's winner from its stocks, since slippi-js's getWinners() leaves
 * most tournament games undecided. Rules, in order:
 *  - a player with no stocks left loses (method "stocks");
 *  - on timeout, more stocks wins, then lower percent (method "time");
 *  - a quit-out after the first 30 seconds is a forfeit by the quitter, unless the
 *    quitter was ahead on stocks, which is ambiguous (method "lras");
 *  - anything else (short restarts, truncated files, ties) has no winner.
 */
export function decideWinner(g: WinnerInput): { winner: number | null; winMethod: WinMethod | null } {
  if (g.players.length !== 2) return { winner: null, winMethod: null };
  const [a, b] = g.players.map((p) => {
    const own = g.stocks.filter((s) => s.playerIndex === p.playerIndex);
    const lost = own.filter((s) => s.endFrame != null).length;
    const current = own.find((s) => s.endFrame == null);
    return { index: p.playerIndex, left: p.startStocks - lost, percent: current?.currentPercent ?? 0 };
  });

  if ((a.left <= 0) !== (b.left <= 0)) {
    return { winner: a.left <= 0 ? b.index : a.index, winMethod: "stocks" };
  }
  if (a.left <= 0 && b.left <= 0) return { winner: null, winMethod: null };

  if (g.endMethod === END_TIME) {
    if (a.left !== b.left) return { winner: a.left > b.left ? a.index : b.index, winMethod: "time" };
    if (a.percent !== b.percent) return { winner: a.percent < b.percent ? a.index : b.index, winMethod: "time" };
    return { winner: null, winMethod: null };
  }

  if (g.endMethod === END_NO_CONTEST && g.lrasInitiator != null && g.lrasInitiator >= 0 && g.lastFrame >= RESTART_FRAMES) {
    const quitter = g.lrasInitiator === a.index ? a : g.lrasInitiator === b.index ? b : null;
    const other = quitter === a ? b : a;
    if (quitter && quitter.left <= other.left) return { winner: other.index, winMethod: "lras" };
  }
  return { winner: null, winMethod: null };
}

/** Opening types, stored as small codes in the conversion detail. */
const OPENING_CODES: Record<string, number> = { "neutral-win": 1, "counter-attack": 2, trade: 3 };

export interface PlayerGameStats {
  playerIndex: number;
  connectCode: string | null;
  displayName: string | null;
  characterId: number | null;
  characterColor: number | null;
  isCpu: boolean;
  startStocks: number;
  stocksLost: number;
  finalPercent: number;
  /** Conversions this player started (Lucky Stats' "openings"). */
  openings: number;
  successfulConversions: number;
  kills: number;
  damageDealt: number;
  neutralWins: number;
  counterHits: number;
  beneficialTrades: number;
  inputsPerMinute: number;
  digitalInputsPerMinute: number;
  inputCounts: Record<string, number>;
  actions: Record<string, unknown>;
}

export interface GameStatsSummary {
  version: number;
  stageId: number | null;
  lastFrame: number;
  gameComplete: boolean;
  endMethod: number | null;
  lrasInitiator: number | null;
  isTeams: boolean;
  numPlayers: number;
  hasCpu: boolean;
  winner: number | null;
  winMethod: WinMethod | null;
  players: PlayerGameStats[];
}

/**
 * One compact row per conversion: [attacker, defender, startFrame, endFrame,
 * startPercent, endPercent, moves, didKill (0/1), openingType code].
 */
export type ConversionRow = [number, number, number, number, number, number, number, number, number];

const round = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? 0 : Math.round(n * 10 ** d) / 10 ** d);

/** Full stats for one replay file. Throws if the file can't be parsed. */
export function extractGameStats(filePath: string): { summary: GameStatsSummary; conversions: ConversionRow[] } {
  const game = new SlippiGame(filePath);
  const settings = game.getSettings();
  const stats = game.getStats();
  const end = game.getGameEnd();
  const meta = game.getMetadata();
  if (!settings || !stats) throw new Error("No settings or stats");

  const settingPlayers = settings.players ?? [];
  const endMethod = end?.gameEndMethod ?? null;
  const lrasInitiator = end?.lrasInitiatorIndex ?? null;
  const lastFrame = stats.lastFrame ?? 0;
  const { winner, winMethod } = decideWinner({
    players: settingPlayers.map((p) => ({ playerIndex: p.playerIndex, startStocks: p.startStocks ?? 4 })),
    stocks: stats.stocks,
    lastFrame,
    endMethod,
    lrasInitiator,
  });

  const players: PlayerGameStats[] = settingPlayers.map((p) => {
    const overall = stats.overall.find((o) => o.playerIndex === p.playerIndex);
    const { playerIndex: _pi, ...actions } = stats.actionCounts.find((a) => a.playerIndex === p.playerIndex) ?? ({} as any);
    const own = stats.stocks.filter((s) => s.playerIndex === p.playerIndex);
    const names = (meta?.players as any)?.[p.playerIndex]?.names;
    return {
      playerIndex: p.playerIndex,
      connectCode: p.connectCode || names?.code || null,
      displayName: p.displayName || names?.netplay || null,
      characterId: p.characterId ?? null,
      characterColor: p.characterColor ?? null,
      isCpu: p.type === 1,
      startStocks: p.startStocks ?? 4,
      stocksLost: own.filter((s) => s.endFrame != null).length,
      finalPercent: round(own.find((s) => s.endFrame == null)?.currentPercent ?? 0),
      openings: overall?.conversionCount ?? 0,
      successfulConversions: overall?.successfulConversions?.count ?? 0,
      kills: overall?.killCount ?? 0,
      damageDealt: round(overall?.totalDamage),
      neutralWins: overall?.neutralWinRatio?.count ?? 0,
      counterHits: overall?.counterHitRatio?.count ?? 0,
      beneficialTrades: overall?.beneficialTradeRatio?.count ?? 0,
      inputsPerMinute: round(overall?.inputsPerMinute?.ratio, 1),
      digitalInputsPerMinute: round(overall?.digitalInputsPerMinute?.ratio, 1),
      inputCounts: (overall?.inputCounts as unknown as Record<string, number>) ?? {},
      actions,
    };
  });

  const conversions: ConversionRow[] = stats.conversions.map((c) => [
    c.lastHitBy ?? -1,
    c.playerIndex,
    c.startFrame,
    c.endFrame ?? lastFrame,
    round(c.startPercent),
    round(c.endPercent ?? c.currentPercent),
    c.moves.length,
    c.didKill ? 1 : 0,
    OPENING_CODES[c.openingType] ?? 0,
  ]);

  return {
    summary: {
      version: STATS_VERSION,
      stageId: settings.stageId ?? null,
      lastFrame,
      gameComplete: !!stats.gameComplete,
      endMethod,
      lrasInitiator,
      isTeams: !!settings.isTeams,
      numPlayers: settingPlayers.length,
      hasCpu: settingPlayers.some((p) => p.type === 1),
      winner,
      winMethod,
      players,
    },
    conversions,
  };
}
