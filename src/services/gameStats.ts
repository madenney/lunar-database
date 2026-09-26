import { SlippiGame } from "@slippi/slippi-js/node";
import {
  detectCombos,
  detectPhantoms,
  findEdgeguards,
  frameBounds,
  getDeathDirection,
  DEFAULT_COMBO_TIMEOUT,
} from "../vendor/replay-analysis";

/**
 * Bump when the extracted shape or rules change; shards are planned per version.
 * v2: match/rules/platform context, result evidence, conversion move lists,
 * deaths with kill moves, and Clipper's combos, edgeguards and phantoms.
 */
export const STATS_VERSION = 2;

/** Version of decideWinner's rules, stored with each inferred result. */
export const RESULT_POLICY = 1;

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

/** Death direction codes in the detail: 0 down, 1 left, 2 right, 3 up. */
const DIRECTION_CODES: Record<string, number> = { down: 0, left: 1, right: 2, up: 3 };

export interface PlayerGameStats {
  playerIndex: number;
  connectCode: string | null;
  displayName: string | null;
  /** Slippi account ID (netplay); stable when a player changes code or name. */
  userId: string | null;
  nametag: string | null;
  controllerFix: string | null;
  teamId: number | null;
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

/** Online match context from the replay (Slippi 3.14+); null fields when absent. */
export interface MatchInfo {
  /** Set/session ID shared by every game of an online set. */
  id: string | null;
  /** "ranked", "unranked", "direct", "teams"… parsed from the ID. */
  mode: string | null;
  gameNumber: number | null;
  tiebreaker: number | null;
}

export interface GameStatsSummary {
  version: number;
  slpVersion: string | null;
  /** Where it was recorded: "dolphin", "network" (console mirroring) or "nintendont". */
  playedOn: string | null;
  consoleNick: string | null;
  match: MatchInfo;
  rules: {
    timerType: number | null;
    startingTimerSeconds: number | null;
    itemSpawnBehavior: number | null;
    friendlyFire: boolean | null;
    gameMode: number | null;
    isPAL: boolean | null;
    isFrozenPS: boolean | null;
  };
  /** Rollback frames recorded in the file (netplay); not a latency measure. */
  rollbackFrames: number;
  /** Observed placements from the game-end event, when the file has them. */
  placements: { playerIndex: number; position: number | null }[];
  resultPolicy: number;
  /** Detectors that threw on this file (their events are missing, not empty). */
  detectorErrors: string[];
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

/** A landed move: [moveId, frame, damage, hitCount]. */
export type MoveRow = [number, number, number, number];

/**
 * One compact row per conversion: [attacker, defender, startFrame, endFrame,
 * startPercent, endPercent, moveCount, didKill (0/1), openingType code, moves].
 * endFrame/endPercent are null when the conversion was still going at game end.
 */
export type ConversionRow = [number, number, number, number | null, number, number | null, number, number, number, MoveRow[]];

/**
 * A combo as Clipper's combo parser finds it (45-frame timeout): [comboer,
 * comboee, startFrame, endFrame, startPercent, endPercent, didKill, moves].
 * endFrame/endPercent are null when the combo was still going at game end.
 */
export type ComboRow = [number, number, number, number | null, number, number | null, number, MoveRow[]];

/**
 * A lost stock: [victim, deathFrame, percent, direction code | null, killer | null,
 * killMoveId | null, stockStartFrame]. Killer and move come from the conversion
 * that took the stock; null for self-destructs and unattributed deaths.
 */
export type DeathRow = [number, number, number, number | null, number | null, number | null, number];

/** An edgeguard kill (Clipper's detector): [victim, edgeguarder, startFrame, endFrame, metrics]. */
export type EdgeguardRow = [number, number, number, number, Record<string, unknown>];

/** A phantom hit (Clipper's detector): [attacker, victim, metrics]. */
export type PhantomRow = [number, number, Record<string, unknown>];

/** Everything per game that goes to the detail files instead of MongoDB. */
export interface GameEvents {
  conversions: ConversionRow[];
  combos: ComboRow[];
  deaths: DeathRow[];
  edgeguards: EdgeguardRow[];
  phantoms: PhantomRow[];
}

const round = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? 0 : Math.round(n * 10 ** d) / 10 ** d);

const moveRows = (moves: { moveId: number; frame: number; damage: number; hitCount: number }[]): MoveRow[] =>
  moves.map((m) => [m.moveId, m.frame, round(m.damage, 1), m.hitCount]);

/** "mode.ranked-2024-…" → "ranked". */
export function matchMode(id: string | null | undefined): string | null {
  const m = /^mode\.([a-z]+)/i.exec(id ?? "");
  return m ? m[1].toLowerCase() : null;
}

/** Full stats and events for one replay file. Throws if the file can't be parsed. */
export function extractGameStats(filePath: string): { summary: GameStatsSummary; events: GameEvents } {
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
      userId: p.userId || null,
      nametag: p.nametag || null,
      controllerFix: p.controllerFix ?? null,
      teamId: settings.isTeams ? (p.teamId ?? null) : null,
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
    c.endFrame ?? null,
    round(c.startPercent),
    c.endPercent == null ? null : round(c.endPercent),
    c.moves.length,
    c.didKill ? 1 : 0,
    OPENING_CODES[c.openingType] ?? 0,
    moveRows(c.moves),
  ]);

  const deaths: DeathRow[] = stats.stocks
    .filter((st) => st.endFrame != null)
    .map((st) => {
      // The conversion that took this stock ends on (or right by) the death frame.
      const kill = stats.conversions
        .filter((c) => c.playerIndex === st.playerIndex && c.didKill && c.endFrame != null)
        .sort((a, b) => Math.abs(a.endFrame! - st.endFrame!) - Math.abs(b.endFrame! - st.endFrame!))[0];
      const killer = kill && Math.abs(kill.endFrame! - st.endFrame!) <= 60 ? kill : null;
      const direction = st.deathAnimation != null ? getDeathDirection(st.deathAnimation) : null;
      return [
        st.playerIndex,
        st.endFrame!,
        round(st.endPercent ?? st.currentPercent),
        direction ? DIRECTION_CODES[direction] : null,
        killer?.lastHitBy ?? null,
        killer?.moves[killer.moves.length - 1]?.moveId ?? null,
        st.startFrame,
      ];
    });

  // Clipper's detectors, on 1v1 games (their rules assume one opponent).
  const events: GameEvents = { conversions, combos: [], deaths, edgeguards: [], phantoms: [] };
  const detectorErrors: string[] = [];
  const attempt = (name: string, run: () => void) => {
    try {
      run();
    } catch {
      detectorErrors.push(name); // e.g. a frame without player data in a damaged file
    }
  };
  if (settingPlayers.length === 2) {
    const frames = game.getFrames();
    attempt("combos", () => {
      const rows: ComboRow[] = [];
      for (const c of detectCombos(frames, settings, DEFAULT_COMBO_TIMEOUT)) {
        if (!c.moves.length) continue; // Clipper drops combos without a landed move
        rows.push([
          c.moves[0].playerIndex,
          c.playerIndex,
          c.startFrame,
          c.endFrame ?? null,
          round(c.startPercent),
          c.endPercent == null ? null : round(c.endPercent),
          c.didKill ? 1 : 0,
          moveRows(c.moves),
        ]);
      }
      events.combos = rows;
    });
    const players = settingPlayers.map((p) => ({ playerIndex: p.playerIndex, characterId: p.characterId ?? -1 }));
    attempt("edgeguards", () => {
      events.edgeguards = findEdgeguards(frames, stats.stocks, players, settings.stageId ?? -1).map((eg) => [
        eg.victimIndex,
        eg.edgeguarderIndex,
        eg.startFrame,
        eg.endFrame,
        eg.metrics,
      ]);
    });
    attempt("phantoms", () => {
      const bounds = frameBounds(frames);
      if (!bounds) return;
      events.phantoms = detectPhantoms(frames, players.map((p) => p.playerIndex), bounds.min, bounds.max).map(
        (ph) => [ph.attackerIndex, ph.victimIndex, ph.metrics]
      );
    });
  }

  const matchInfo = settings.matchInfo;
  const matchId = matchInfo?.sessionId || matchInfo?.matchId || null;
  let rollbackFrames = 0;
  try {
    rollbackFrames = game.getRollbackFrames().count;
  } catch {
    // Older files carry no rollback information.
  }

  return {
    summary: {
      version: STATS_VERSION,
      slpVersion: settings.slpVersion ?? null,
      playedOn: meta?.playedOn ?? null,
      consoleNick: meta?.consoleNick ?? null,
      match: {
        id: matchId,
        mode: matchMode(matchId),
        gameNumber: matchInfo?.gameNumber ?? null,
        tiebreaker: matchInfo?.tiebreakerNumber ?? null,
      },
      rules: {
        timerType: settings.timerType ?? null,
        startingTimerSeconds: settings.startingTimerSeconds ?? null,
        itemSpawnBehavior: settings.itemSpawnBehavior ?? null,
        friendlyFire: settings.friendlyFireEnabled ?? null,
        gameMode: settings.gameMode ?? null,
        isPAL: settings.isPAL ?? null,
        isFrozenPS: settings.isFrozenPS ?? null,
      },
      rollbackFrames,
      placements: (end?.placements ?? []).map((pl) => ({ playerIndex: pl.playerIndex, position: pl.position ?? null })),
      resultPolicy: RESULT_POLICY,
      detectorErrors,
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
    events,
  };
}
