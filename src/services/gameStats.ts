import crypto from "crypto";
import fs from "fs";
import { SlippiGame } from "@slippi/slippi-js/node";
import {
  detectCombos,
  detectPhantoms,
  findEarlyQuitOut,
  findEdgeguards,
  frameBounds,
  getDeathDirection,
  positionStats,
  techLedgeEvents,
  DEFAULT_COMBO_TIMEOUT,
  type PositionStats,
} from "../vendor/replay-analysis";
import { readMatchInfo, type MatchInfo } from "./matchInfo";

export { matchMode } from "./matchInfo";

/**
 * Independently versioned pieces of the extraction. Bump an extractor's version
 * when its output (fields, events or rules) changes; a new stats run then
 * recomputes just that extractor. Adding an extractor needs a run for it alone.
 * Each one's summary fields are $set on the game's record without touching the
 * others, and its events go to detail/<name>/v<version>/.
 *
 *  core      game/match/rules context, result, per-player stats; conversions, deaths
 *  clipper   Clipper's combos, edgeguards, phantoms and early quit-outs (1v1)
 *  identity  content hash, cross-recording fingerprint, Gecko code list
 *  position  stage position/posture per player, distance between players
 *  techLedge tech, getup and ledge options (events + per-player counts)
 */
export const EXTRACTORS = {
  core: 2,
  clipper: 1,
  identity: 1,
  position: 1,
  techLedge: 1,
} as const;
export type ExtractorName = keyof typeof EXTRACTORS;
export const EXTRACTOR_NAMES = Object.keys(EXTRACTORS) as ExtractorName[];

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

/** Summary fields written by the core extractor. */
export interface CoreSummary {
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

/** An early quit-out (denied kill): [comboer, quitter, startFrame, quitFrame, startPercent, percentAtQuit, moves]. */
export type EarlyQuitOutRow = [number, number, number, number, number, number, MoveRow[]];

/** A tech/getup/ledge choice: [player, frame, kind, option, "toward" | "away" | null, percent]. */
export type TechLedgeRow = [number, number, string, string, string | null, number];

/** Summary fields written by the identity extractor. */
export interface IdentitySummary {
  /** SHA-256 of the replay bytes: one byte-identical recording. */
  contentHash: string;
  /**
   * Same for every recording of one played game (both players' netplay files,
   * console + mirror): stage, RNG seed, ports/characters/colors/codes and the
   * online session. Candidate duplicates, confirmed by later matching.
   */
  fingerprint: string;
  gecko: { count: number; hash: string | null };
}

/** Per-player tech/getup/ledge option counts, from the techLedge events. */
export type TechLedgeCounts = Record<string, Record<string, number>>;

/** Output of one or more extractors for one game. */
export interface GameExtraction {
  /** Summary fields, $set on the game's record. */
  fields: Record<string, unknown>;
  /** Extractors that ran, with their versions. */
  versions: Partial<Record<ExtractorName, number>>;
  /** Sub-detectors that threw, per extractor (their events are missing, not empty). */
  errors: Partial<Record<ExtractorName, string[]>>;
  /** Detail events per extractor, keyed by event type. */
  events: Partial<Record<ExtractorName, Record<string, unknown>>>;
}

const round = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? 0 : Math.round(n * 10 ** d) / 10 ** d);

const moveRows = (moves: { moveId: number; frame: number; damage: number; hitCount: number }[]): MoveRow[] =>
  moves.map((m) => [m.moveId, m.frame, round(m.damage, 1), m.hitCount]);


const sha256 = (data: crypto.BinaryLike) => crypto.createHash("sha256").update(data).digest("hex");

/**
 * Run the given extractors on one replay, parsing it once. Throws if the file
 * can't be parsed at all; a sub-detector that throws is recorded in `errors` and
 * the rest of the extraction is kept.
 */
export function extractGame(filePath: string, names: readonly ExtractorName[] = EXTRACTOR_NAMES): GameExtraction {
  const bytes = fs.readFileSync(filePath);
  const game = new SlippiGame(bytes);
  const settings = game.getSettings();
  if (!settings) throw new Error("No settings");
  const out: GameExtraction = { fields: {}, versions: {}, errors: {}, events: {} };
  const settingPlayers = settings.players ?? [];
  const is1v1 = settingPlayers.length === 2;
  const stageId = settings.stageId ?? -1;
  const playerIndexes = settingPlayers.map((p) => p.playerIndex);

  // Parsed pieces are shared between extractors and computed only when needed.
  let stats: ReturnType<SlippiGame["getStats"]> | undefined;
  const getStats = () => {
    if (stats === undefined) stats = game.getStats();
    if (!stats) throw new Error("No stats");
    return stats;
  };
  const frames = () => game.getFrames();

  const attempt = (extractor: ExtractorName, detector: string, run: () => void) => {
    try {
      run();
    } catch {
      // e.g. a frame without player data in a damaged file
      (out.errors[extractor] ??= []).push(detector);
    }
  };

  for (const name of names) {
    if (name === "core") {
      const { summary, conversions, deaths } = extractCore(game, getStats());
      Object.assign(out.fields, summary);
      out.events.core = { conversions, deaths };
    } else if (name === "clipper") {
      const ev: Record<string, unknown> = { combos: [], edgeguards: [], phantoms: [], earlyQuitOut: null };
      if (is1v1) {
        attempt("clipper", "combos", () => {
          const rows: ComboRow[] = [];
          for (const c of detectCombos(frames(), settings, DEFAULT_COMBO_TIMEOUT)) {
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
          ev.combos = rows;
        });
        const players = settingPlayers.map((p) => ({ playerIndex: p.playerIndex, characterId: p.characterId ?? -1 }));
        attempt("clipper", "edgeguards", () => {
          ev.edgeguards = findEdgeguards(frames(), getStats().stocks, players, stageId).map(
            (eg): EdgeguardRow => [eg.victimIndex, eg.edgeguarderIndex, eg.startFrame, eg.endFrame, eg.metrics]
          );
        });
        attempt("clipper", "phantoms", () => {
          const bounds = frameBounds(frames());
          if (!bounds) return;
          ev.phantoms = detectPhantoms(frames(), playerIndexes, bounds.min, bounds.max).map(
            (ph): PhantomRow => [ph.attackerIndex, ph.victimIndex, ph.metrics]
          );
        });
        attempt("clipper", "earlyQuitOut", () => {
          const q = findEarlyQuitOut(frames(), settings, game.getGameEnd(), game.getMetadata()?.lastFrame);
          if (!q) return;
          const row: EarlyQuitOutRow = [
            q.combo.moves[0].playerIndex,
            q.quitterIndex,
            q.combo.startFrame,
            q.gameLastFrame,
            round(q.combo.startPercent),
            round(q.victimPercent),
            moveRows(q.combo.moves),
          ];
          ev.earlyQuitOut = row;
        });
      }
      out.events.clipper = ev;
    } else if (name === "identity") {
      out.fields.contentHash = sha256(bytes);
      out.fields.fingerprint = gameFingerprint(settings);
      const gecko = game.getGeckoList();
      out.fields.gecko = {
        count: gecko?.codes.length ?? 0,
        hash: gecko ? sha256(Buffer.from(gecko.contents)).slice(0, 16) : null,
      };
    } else if (name === "position") {
      attempt("position", "position", () => {
        const pos: PositionStats = positionStats(frames(), playerIndexes, stageId);
        out.fields.position = pos;
      });
    } else if (name === "techLedge") {
      attempt("techLedge", "techLedge", () => {
        const events = techLedgeEvents(frames(), playerIndexes, stageId);
        const counts: TechLedgeCounts = {};
        for (const e of events) {
          const key = `${e.kind}.${e.option}${e.direction ? `.${e.direction}` : ""}`;
          const perPlayer = (counts[e.playerIndex] ??= {});
          perPlayer[key] = (perPlayer[key] ?? 0) + 1;
        }
        out.fields.techLedge = counts;
        out.events.techLedge = {
          options: events.map((e): TechLedgeRow => [e.playerIndex, e.frame, e.kind, e.option, e.direction, e.percent]),
        };
      });
    }
    out.versions[name] = EXTRACTORS[name];
  }
  return out;
}

/** Same for every recording of one played game; see IdentitySummary.fingerprint. */
export function gameFingerprint(settings: {
  stageId?: number | null;
  randomSeed?: number | null;
  matchInfo?: Parameters<typeof readMatchInfo>[0];
  players: { port?: number | null; characterId?: number | null; characterColor?: number | null; connectCode?: string | null; startStocks?: number | null }[];
}): string {
  const match = readMatchInfo(settings.matchInfo);
  const players = [...settings.players]
    .sort((a, b) => (a.port ?? 0) - (b.port ?? 0))
    .map((p) => [p.port ?? null, p.characterId ?? null, p.characterColor ?? null, p.connectCode || null, p.startStocks ?? null]);
  const key = JSON.stringify([settings.stageId ?? null, settings.randomSeed ?? null, match.id, match.gameNumber, match.tiebreaker, players]);
  return sha256(key).slice(0, 32);
}

function extractCore(game: SlippiGame, stats: NonNullable<ReturnType<SlippiGame["getStats"]>>) {
  const settings = game.getSettings()!;
  const end = game.getGameEnd();
  const meta = game.getMetadata();
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

  let rollbackFrames = 0;
  try {
    rollbackFrames = game.getRollbackFrames().count;
  } catch {
    // Older files carry no rollback information.
  }

  const summary: CoreSummary = {
    slpVersion: settings.slpVersion ?? null,
    playedOn: meta?.playedOn ?? null,
    consoleNick: meta?.consoleNick ?? null,
    match: readMatchInfo(settings.matchInfo),
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
  };
  return { summary, conversions, deaths };
}
