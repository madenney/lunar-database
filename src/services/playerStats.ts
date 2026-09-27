/**
 * Career stats per connect code, aggregated from gameStats (scripts/buildPlayerStats.ts).
 *
 * Only human 1v1 games count. Totals are stored raw (sums and counts) so rates
 * are derived where they're shown and stay correct when games are added.
 * Profiles are keyed by connect code; codes that share a Slippi user ID are
 * listed on each other's profiles as the same account's other codes.
 */

export interface GameForProfile {
  replayId: unknown;
  source?: string | null;
  startAt?: Date | null;
  stageId?: number | null;
  winner?: number | null;
  numPlayers?: number;
  hasCpu?: boolean;
  players?: {
    playerIndex: number;
    connectCode?: string | null;
    displayName?: string | null;
    userId?: string | null;
    characterId?: number | null;
    stocksLost?: number;
    kills?: number;
    openings?: number;
    damageDealt?: number;
    neutralWins?: number;
    counterHits?: number;
    inputsPerMinute?: number;
    actions?: {
      lCancelCount?: { success?: number; fail?: number };
      wavedashCount?: number;
      dashDanceCount?: number;
      ledgegrabCount?: number;
    };
  }[];
  position?: { players?: { playerIndex: number; activeFrames?: number; center?: number | null; offstage?: number | null; closer?: number | null }[] };
  techLedge?: Record<string, Record<string, number>>;
}

export type Record3 = { games: number; decided: number; wins: number };

export interface PlayerTotals {
  kills: number;
  stocksLost: number;
  openings: number;
  damageDealt: number;
  neutralWins: number;
  oppNeutralWins: number;
  counterHits: number;
  ipmSum: number;
  lCancelSuccess: number;
  lCancelFail: number;
  wavedashes: number;
  dashDances: number;
  ledgeGrabs: number;
  /** Position sums over games that have the position extractor. */
  positionGames: number;
  activeFrames: number;
  centerFrames: number;
  offstageFrames: number;
  closerFrames: number;
  oppCloserFrames: number;
}

export interface PlayerProfile {
  connectCode: string;
  names: { name: string; games: number }[];
  userIds: string[];
  otherCodes: string[];
  games: number;
  decided: number;
  wins: number;
  firstPlayed: Date | null;
  lastPlayed: Date | null;
  sources: Record<string, number>;
  characters: ({ characterId: number } & Record3)[];
  stages: ({ stageId: number } & Record3)[];
  vsCharacters: ({ characterId: number } & Record3)[];
  opponents: ({ connectCode: string; name: string | null } & Record3)[];
  monthly: ({ month: string } & Record3)[];
  totals: PlayerTotals;
  techLedge: Record<string, number>;
}

const MAX_OPPONENTS = 15;
const MAX_NAMES = 8;
const MAX_MONTHS = 36;

type Acc = {
  code: string;
  names: Map<string, number>;
  userIds: Set<string>;
  overall: Record3;
  firstPlayed: Date | null;
  lastPlayed: Date | null;
  sources: Map<string, number>;
  characters: Map<number, Record3>;
  stages: Map<number, Record3>;
  vsCharacters: Map<number, Record3>;
  opponents: Map<string, Record3 & { name: string | null }>;
  monthly: Map<string, Record3>;
  totals: PlayerTotals;
  techLedge: Map<string, number>;
};

const blank = (): Record3 => ({ games: 0, decided: 0, wins: 0 });
const bump = (r: Record3, decided: boolean, won: boolean) => {
  r.games += 1;
  if (decided) r.decided += 1;
  if (won) r.wins += 1;
};
const inMap = <K>(m: Map<K, Record3>, k: K) => {
  let r = m.get(k);
  if (!r) m.set(k, (r = blank()));
  return r;
};

/** A human 1v1 game, which is all profiles count. */
export function countsForProfiles(g: GameForProfile): boolean {
  return g.numPlayers === 2 && !g.hasCpu && (g.players?.length ?? 0) === 2;
}

export class PlayerStatsBuilder {
  private accs = new Map<string, Acc>();

  get size(): number {
    return this.accs.size;
  }

  private acc(code: string): Acc {
    let a = this.accs.get(code);
    if (!a) {
      a = {
        code,
        names: new Map(),
        userIds: new Set(),
        overall: blank(),
        firstPlayed: null,
        lastPlayed: null,
        sources: new Map(),
        characters: new Map(),
        stages: new Map(),
        vsCharacters: new Map(),
        opponents: new Map(),
        monthly: new Map(),
        totals: {
          kills: 0, stocksLost: 0, openings: 0, damageDealt: 0, neutralWins: 0, oppNeutralWins: 0, counterHits: 0,
          ipmSum: 0, lCancelSuccess: 0, lCancelFail: 0, wavedashes: 0, dashDances: 0, ledgeGrabs: 0,
          positionGames: 0, activeFrames: 0, centerFrames: 0, offstageFrames: 0, closerFrames: 0, oppCloserFrames: 0,
        },
        techLedge: new Map(),
      };
      this.accs.set(code, a);
    }
    return a;
  }

  add(g: GameForProfile): void {
    if (!countsForProfiles(g)) return;
    const players = g.players!;
    const decided = g.winner != null;
    const month = g.startAt ? new Date(g.startAt).toISOString().slice(0, 7) : null;
    players.forEach((me, i) => {
      const code = me.connectCode;
      if (!code) return;
      const opp = players[1 - i];
      const won = decided && g.winner === me.playerIndex;
      const a = this.acc(code);

      bump(a.overall, decided, won);
      if (me.displayName) a.names.set(me.displayName, (a.names.get(me.displayName) ?? 0) + 1);
      if (me.userId) a.userIds.add(me.userId);
      if (g.startAt) {
        const t = new Date(g.startAt);
        if (!a.firstPlayed || t < a.firstPlayed) a.firstPlayed = t;
        if (!a.lastPlayed || t > a.lastPlayed) a.lastPlayed = t;
      }
      if (g.source) a.sources.set(g.source, (a.sources.get(g.source) ?? 0) + 1);
      if (me.characterId != null) bump(inMap(a.characters, me.characterId), decided, won);
      if (g.stageId != null) bump(inMap(a.stages, g.stageId), decided, won);
      if (opp.characterId != null) bump(inMap(a.vsCharacters, opp.characterId), decided, won);
      if (month) bump(inMap(a.monthly, month), decided, won);
      if (opp.connectCode) {
        let o = a.opponents.get(opp.connectCode);
        if (!o) a.opponents.set(opp.connectCode, (o = { ...blank(), name: null }));
        bump(o, decided, won);
        if (opp.displayName) o.name = opp.displayName;
      }

      const t = a.totals;
      t.kills += me.kills ?? 0;
      t.stocksLost += me.stocksLost ?? 0;
      t.openings += me.openings ?? 0;
      t.damageDealt += me.damageDealt ?? 0;
      t.neutralWins += me.neutralWins ?? 0;
      t.oppNeutralWins += opp.neutralWins ?? 0;
      t.counterHits += me.counterHits ?? 0;
      t.ipmSum += me.inputsPerMinute ?? 0;
      t.lCancelSuccess += me.actions?.lCancelCount?.success ?? 0;
      t.lCancelFail += me.actions?.lCancelCount?.fail ?? 0;
      t.wavedashes += me.actions?.wavedashCount ?? 0;
      t.dashDances += me.actions?.dashDanceCount ?? 0;
      t.ledgeGrabs += me.actions?.ledgegrabCount ?? 0;

      const pos = g.position?.players;
      const mine = pos?.find((p) => p.playerIndex === me.playerIndex);
      const theirs = pos?.find((p) => p.playerIndex === opp.playerIndex);
      if (mine?.activeFrames) {
        t.positionGames += 1;
        t.activeFrames += mine.activeFrames;
        t.centerFrames += mine.center ?? 0;
        t.offstageFrames += mine.offstage ?? 0;
        t.closerFrames += mine.closer ?? 0;
        t.oppCloserFrames += theirs?.closer ?? 0;
      }
      for (const [k, n] of Object.entries(g.techLedge?.[me.playerIndex] ?? {})) {
        a.techLedge.set(k, (a.techLedge.get(k) ?? 0) + n);
      }
    });
  }

  /** Finished profiles, with codes sharing a Slippi user ID linked to each other. */
  *profiles(): Generator<PlayerProfile> {
    const codesByUser = new Map<string, Set<string>>();
    for (const a of this.accs.values()) {
      for (const u of a.userIds) {
        if (!codesByUser.has(u)) codesByUser.set(u, new Set());
        codesByUser.get(u)!.add(a.code);
      }
    }
    const sorted = <T extends Record3>(m: Map<number | string, T>, key: string) =>
      [...m.entries()].map(([k, r]) => ({ [key]: k, ...r })).sort((x, y) => y.games - x.games);

    for (const a of this.accs.values()) {
      const other = new Set<string>();
      for (const u of a.userIds) for (const c of codesByUser.get(u) ?? []) if (c !== a.code) other.add(c);
      yield {
        connectCode: a.code,
        names: [...a.names.entries()].sort((x, y) => y[1] - x[1]).slice(0, MAX_NAMES).map(([name, games]) => ({ name, games })),
        userIds: [...a.userIds],
        otherCodes: [...other].sort(),
        games: a.overall.games,
        decided: a.overall.decided,
        wins: a.overall.wins,
        firstPlayed: a.firstPlayed,
        lastPlayed: a.lastPlayed,
        sources: Object.fromEntries(a.sources),
        characters: sorted(a.characters, "characterId") as PlayerProfile["characters"],
        stages: sorted(a.stages, "stageId") as PlayerProfile["stages"],
        vsCharacters: sorted(a.vsCharacters, "characterId") as PlayerProfile["vsCharacters"],
        opponents: [...a.opponents.entries()]
          .sort((x, y) => y[1].games - x[1].games)
          .slice(0, MAX_OPPONENTS)
          .map(([connectCode, r]) => ({ connectCode, ...r })),
        monthly: [...a.monthly.entries()]
          .sort((x, y) => (x[0] < y[0] ? -1 : 1))
          .slice(-MAX_MONTHS)
          .map(([month, r]) => ({ month, ...r })),
        totals: a.totals,
        techLedge: Object.fromEntries(a.techLedge),
      };
    }
  }
}
