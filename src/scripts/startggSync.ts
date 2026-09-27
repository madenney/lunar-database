/**
 * Link online start.gg sets to archive games (services/startgg.ts).
 *
 *   npm run startgg-sync                  discover new events, then check and match pending ones
 *   npm run startgg-sync -- --status      progress by status
 *   npm run startgg-sync -- --recheck     re-check finished events against the archive (after new imports)
 *   npm run startgg-sync -- --from 2019-01 --max-events 200
 *   npm run startgg-sync -- --no-discover --before 2025-04-01   only events that started before a date
 *
 * Needs STARTGG_TOKEN. Resumable: progress lives in the startggEvents collection,
 * so a stopped run picks up where it left off. Per event:
 *   1. discover: online Melee singles events, month by month (tournaments query);
 *   2. entrants: their linked connect codes; events where no two entrants have
 *      archive games around the event date are marked no-games (no set fetch);
 *   3. sets: fetch the sets, match each to its games (matchSet), and write
 *      matched sets (source "startgg-match") plus Replay.setId/setGame.
 * Then run build-tournaments to group the matched games into tournament pages.
 */
import mongoose from "mongoose";
import { connectDb } from "../db";
import { Replay } from "../models/Replay";
import { TournamentSet } from "../models/TournamentSet";
import { StartggEvent, type IStartggEvent } from "../models/StartggEvent";
import { GameStats } from "../models/GameStats";
import { StartggClient, FatalStartggError, matchSet, normCode, type CandidateGame, type SggSet } from "../services/startgg";
import { tournamentFromStartgg } from "../services/tournaments";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Window around an event's start in which its entrants' games count as evidence. */
const EVENT_BEFORE_S = 12 * 3600;
const EVENT_AFTER_S = 3 * 86400;
/** Slack around a set's start/finish when collecting its candidate games. */
const SET_SLACK_S = 20 * 60;

// ---------------------------------------------------------------- archive index

type Game = { id: string; t: number; codes: Record<number, string> };

/** Every usable archive game between exactly two connect codes, by unordered code pair, sorted by time. */
class PairIndex {
  byPair = new Map<string, Game[]>();
  allTimes: number[] = [];

  static key(a: string, b: string) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  async load() {
    const started = Date.now();
    const cursor = Replay.collection.find(
      { usable: true, startAt: { $type: "date" }, "players.1.connectCode": { $type: "string" } },
      { projection: { startAt: 1, "players.playerIndex": 1, "players.connectCode": 1 }, batchSize: 20_000 }
    );
    let n = 0;
    for await (const r of cursor) {
      const players = (r.players ?? []).filter((p: any) => p.connectCode);
      if (players.length !== 2) continue;
      const codes: Record<number, string> = {};
      for (const p of players) codes[p.playerIndex] = String(p.connectCode).toUpperCase();
      const [a, b] = Object.values(codes);
      if (a === b) continue;
      const t = Math.floor((r.startAt as Date).getTime() / 1000);
      const k = PairIndex.key(a, b);
      let list = this.byPair.get(k);
      if (!list) this.byPair.set(k, (list = []));
      list.push({ id: String(r._id), t, codes });
      this.allTimes.push(t);
      if (++n % 500_000 === 0) console.log(`  archive index: ${n.toLocaleString()} games`);
    }
    for (const list of this.byPair.values()) list.sort((x, y) => x.t - y.t);
    this.allTimes.sort((x, y) => x - y);
    console.log(`Archive index: ${n.toLocaleString()} two-code games, ${this.byPair.size.toLocaleString()} pairs (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }

  /** Any two-code game at all in [from, to]? (cheap pre-check before fetching entrants) */
  anyIn(from: number, to: number) {
    const i = lowerBound(this.allTimes, from);
    return i < this.allTimes.length && this.allTimes[i] <= to;
  }

  games(a: string, b: string, from: number, to: number): Game[] {
    const list = this.byPair.get(PairIndex.key(a, b));
    if (!list) return [];
    const out: Game[] = [];
    for (let i = lowerBound(list, from, (g) => g.t); i < list.length && list[i].t <= to; i++) out.push(list[i]);
    return out;
  }

  /** Does any pair of these codes have games in [from, to]? */
  anyPair(codes: string[], from: number, to: number) {
    const unique = [...new Set(codes)];
    for (let i = 0; i < unique.length; i++)
      for (let j = i + 1; j < unique.length; j++) if (this.games(unique[i], unique[j], from, to).length) return true;
    return false;
  }
}

function lowerBound<T>(arr: T[], value: number, get: (x: T) => number = (x) => x as unknown as number) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (get(arr[mid]) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------- start.gg queries

const TOURNAMENTS_Q = `query($page:Int,$after:Timestamp,$before:Timestamp){ tournaments(query:{page:$page, perPage:40, sortBy:"startAt asc", filter:{videogameIds:[1], hasOnlineEvents:true, afterDate:$after, beforeDate:$before}}){ pageInfo{ totalPages } nodes{ id name slug events(filter:{videogameId:[1]}){ id name slug isOnline numEntrants startAt state teamRosterSize{ maxPlayers } } } } }`;
const ENTRANTS_Q = `query($id:ID!,$page:Int){ event(id:$id){ entrants(query:{page:$page, perPage:100}){ pageInfo{ totalPages } nodes{ id participants{ connectedAccounts } } } } }`;
const SETS_Q = `query($id:ID!,$page:Int){ event(id:$id){ sets(page:$page, perPage:30, sortType:STANDARD, filters:{hideEmpty:true}){ pageInfo{ totalPages } nodes{ id startedAt completedAt fullRoundText winnerId games{ orderNum winnerId } slots{ entrant{ id participants{ gamerTag prefix } } standing{ stats{ score{ value } } } } } } } }`;

async function discover(sgg: StartggClient, fromMonth: string) {
  const [y, m] = fromMonth.split("-").map(Number);
  const now = new Date();
  let added = 0;
  for (let d = new Date(Date.UTC(y, m - 1, 1)); d < now; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const after = d.getTime() / 1000;
    const before = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
    let page = 1;
    let pages = 1;
    let monthEvents = 0;
    do {
      const data = await sgg.query(TOURNAMENTS_Q, { page, after, before });
      pages = data.tournaments?.pageInfo?.totalPages ?? 0;
      const ops: any[] = [];
      for (const t of data.tournaments?.nodes ?? []) {
        for (const e of t.events ?? []) {
          const singles = !e.teamRosterSize || (e.teamRosterSize.maxPlayers ?? 1) <= 1;
          if (!e.isOnline || !singles || e.state !== "COMPLETED" || (e.numEntrants ?? 0) < 2) continue;
          monthEvents++;
          ops.push({
            updateOne: {
              filter: { _id: e.id },
              update: {
                $set: { tournament: { id: t.id, name: t.name, slug: t.slug }, name: e.name, slug: e.slug, startAt: e.startAt ?? null, numEntrants: e.numEntrants ?? 0 },
                $setOnInsert: { status: "new" },
              },
              upsert: true,
            },
          });
        }
      }
      if (ops.length) added += (await StartggEvent.collection.bulkWrite(ops, { ordered: false })).upsertedCount;
      page++;
    } while (page <= pages);
    console.log(`discover ${d.toISOString().slice(0, 7)}: ${monthEvents} online singles events`);
  }
  console.log(`Discovery done: ${added} new events.`);
}

async function fetchCodes(sgg: StartggClient, eventId: number) {
  const codes: Record<string, string> = {};
  let entrants = 0;
  let page = 1;
  let pages = 1;
  do {
    const data = await sgg.query(ENTRANTS_Q, { id: eventId, page });
    const conn = data.event?.entrants;
    pages = conn?.pageInfo?.totalPages ?? 0;
    for (const n of conn?.nodes ?? []) {
      entrants++;
      const code = normCode(n.participants?.[0]?.connectedAccounts?.slippi?.value);
      if (code) codes[String(n.id)] = code;
    }
    page++;
  } while (page <= pages);
  return { codes, entrants };
}

// ---------------------------------------------------------------- matching

async function matchEvent(sgg: StartggClient, index: PairIndex, ev: IStartggEvent) {
  const codes = ev.codes ?? {};
  const counts = { total: 0, played: 0, bothCodes: 0, matched: 0 };
  const ref = tournamentFromStartgg(ev.tournament.name, ev.slug) ?? { key: `sgg-${ev.tournament.id}`, name: ev.tournament.name, listed: true, startggSlug: null };
  const gstats = GameStats.collection;
  const builtAt = new Date();
  let page = 1;
  let pages = 1;
  do {
    const data = await sgg.query(SETS_Q, { id: ev._id, page });
    const conn = data.event?.sets;
    pages = conn?.pageInfo?.totalPages ?? 0;
    const pending: { set: SggSet; pair: [string, string]; games: Game[] }[] = [];
    for (const set of (conn?.nodes ?? []) as SggSet[]) {
      counts.total++;
      if (!set.startedAt || !set.completedAt) continue;
      counts.played++;
      const pair = set.slots.map((s) => codes[String(s.entrant?.id)]) as [string, string];
      if (pair.length !== 2 || !pair[0] || !pair[1] || pair[0] === pair[1]) continue;
      counts.bothCodes++;
      const games = index.games(pair[0], pair[1], set.startedAt - SET_SLACK_S, set.completedAt + SET_SLACK_S);
      if (games.length) pending.push({ set, pair, games });
    }
    if (!pending.length) {
      page++;
      continue;
    }
    // Winners and fingerprints for this page's candidate games in one query.
    const ids = pending.flatMap((p) => p.games.map((g) => new mongoose.Types.ObjectId(g.id)));
    const stats = await gstats.find({ replayId: { $in: ids } }, { projection: { replayId: 1, winner: 1, fingerprint: 1 } }).toArray();
    const statOf = new Map(stats.map((s: any) => [String(s.replayId), s]));
    const existing = new Map(
      (await TournamentSet.collection.find({ _id: { $in: pending.map((p) => `sgg-${p.set.id}`) } as any }, { projection: { source: 1 } }).toArray()).map((s: any) => [s._id, s.source])
    );
    const setOps: any[] = [];
    const replayOps: any[] = [];
    for (const { set, pair, games } of pending) {
      const _id = `sgg-${set.id}`;
      if (existing.has(_id) && existing.get(_id) !== "startgg-match") continue; // an offline export already has this set
      const candidates: CandidateGame[] = games.map((g) => {
        const st = statOf.get(g.id);
        return { replayId: g.id, t: g.t, codes: g.codes, winnerIndex: st?.winner ?? null, fingerprint: st?.fingerprint ?? null };
      });
      const m = matchSet(set, pair, candidates);
      if (!m) continue;
      counts.matched++;
      const entrantIds = set.slots.map((s) => s.entrant?.id);
      setOps.push({
        replaceOne: {
          filter: { _id },
          upsert: true,
          replacement: {
            source: "startgg-match",
            tournamentKey: ref.key,
            tournament: ref,
            event: ev.name,
            round: set.fullRoundText ?? null,
            bestOf: null,
            location: "Online",
            startgg: { setId: set.id, eventId: ev._id, eventSlug: ev.slug },
            players: set.slots.map((s) => ({
              name: s.entrant?.participants?.[0]?.gamerTag ?? "Player",
              prefix: s.entrant?.participants?.[0]?.prefix || null,
              port: null,
              score: s.standing?.stats?.score?.value ?? null,
            })),
            winner: set.winnerId != null && entrantIds.includes(set.winnerId) ? entrantIds.indexOf(set.winnerId) : null,
            games: m.games.map((g) => ({ replayId: new mongoose.Types.ObjectId(g.replayId), n: g.n, winner: g.winner })),
            startAt: new Date(set.startedAt! * 1000),
            dir: "",
            match: { method: m.method },
            builtAt,
          },
        },
      });
      // Never take a game away from another set (e.g. an offline export).
      for (const g of m.games) {
        replayOps.push({
          updateOne: {
            filter: { _id: new mongoose.Types.ObjectId(g.replayId), $or: [{ setId: null }, { setId: { $exists: false } }, { setId: _id }] },
            update: { $set: { setId: _id, setGame: g.n } },
          },
        });
      }
    }
    if (setOps.length) await TournamentSet.collection.bulkWrite(setOps, { ordered: false });
    if (replayOps.length) await Replay.collection.bulkWrite(replayOps, { ordered: false });
    page++;
  } while (page <= pages);
  return counts;
}

// ---------------------------------------------------------------- main

async function status() {
  const rows = await StartggEvent.aggregate([
    { $group: { _id: "$status", events: { $sum: 1 }, matched: { $sum: { $ifNull: ["$sets.matched", 0] } }, bothCodes: { $sum: { $ifNull: ["$sets.bothCodes", 0] } } } },
    { $sort: { _id: 1 } },
  ]);
  for (const r of rows) console.log(`${String(r._id).padEnd(10)} ${String(r.events).padStart(7)} events  ${r.matched ? `${r.matched} sets matched of ${r.bothCodes} with both codes` : ""}`);
  console.log(`matched sets in sets collection: ${await TournamentSet.countDocuments({ source: "startgg-match" })}`);
}

async function main() {
  await connectDb();
  if (flag("--status")) {
    await status();
    return mongoose.disconnect();
  }
  const token = process.env.STARTGG_TOKEN;
  if (!token) throw new Error("STARTGG_TOKEN is not set");
  const sgg = new StartggClient(token);
  const maxEvents = Number(opt("--max-events") ?? Infinity);

  if (!flag("--no-discover")) {
    const latest = await StartggEvent.findOne().sort({ startAt: -1 }).select({ startAt: 1 }).lean();
    const from = opt("--from") ?? (latest?.startAt ? new Date((latest.startAt - 60 * 86400) * 1000).toISOString().slice(0, 7) : "2019-01");
    await discover(sgg, from);
  }
  if (flag("--discover")) return mongoose.disconnect();

  const index = new PairIndex();
  await index.load();

  const statuses = flag("--recheck") ? ["new", "candidate", "error", "no-games", "done"] : ["new", "candidate", "error"];
  const before = opt("--before");
  const todo = await StartggEvent.find({
    status: { $in: statuses },
    ...(before ? { startAt: { $lt: Date.parse(before) / 1000 } } : {}),
  })
    .sort({ startAt: -1 })
    .select({ _id: 1 })
    .lean();
  console.log(`${todo.length.toLocaleString()} events to process`);
  const started = Date.now();
  let processed = 0;
  let matched = 0;
  for (const { _id } of todo) {
    if (processed >= maxEvents) break;
    const ev = (await StartggEvent.findById(_id).lean()) as IStartggEvent | null;
    if (!ev) continue;
    const from = (ev.startAt ?? 0) - EVENT_BEFORE_S;
    const to = (ev.startAt ?? 0) + EVENT_AFTER_S;
    try {
      if (!ev.startAt || !index.anyIn(from, to)) {
        await StartggEvent.updateOne({ _id }, { $set: { status: "no-games", checkedAt: new Date(), error: null } });
      } else {
        if (!ev.codes) {
          const { codes, entrants } = await fetchCodes(sgg, ev._id);
          ev.codes = codes;
          await StartggEvent.updateOne({ _id }, { $set: { codes, entrants } });
        }
        if (!index.anyPair(Object.values(ev.codes), from, to)) {
          await StartggEvent.updateOne({ _id }, { $set: { status: "no-games", checkedAt: new Date(), error: null } });
        } else {
          await StartggEvent.updateOne({ _id }, { $set: { status: "candidate" } });
          const sets = await matchEvent(sgg, index, ev);
          matched += sets.matched;
          await StartggEvent.updateOne({ _id }, { $set: { status: "done", sets, checkedAt: new Date(), error: null } });
          if (sets.matched) console.log(`  ${ev.tournament.name} — ${ev.name}: ${sets.matched}/${sets.bothCodes} sets matched`);
        }
      }
    } catch (err) {
      if (err instanceof FatalStartggError) throw err;
      await StartggEvent.updateOne({ _id }, { $set: { status: "error", error: String((err as Error)?.message ?? err).slice(0, 500), checkedAt: new Date() } });
    }
    processed++;
    if (processed % 100 === 0) {
      const perEvent = (Date.now() - started) / processed;
      const left = Math.min(todo.length, maxEvents) - processed;
      console.log(`${processed.toLocaleString()}/${todo.length.toLocaleString()} events, ${matched.toLocaleString()} sets matched, ${sgg.requests.toLocaleString()} requests, ~${((left * perEvent) / 3_600_000).toFixed(1)} h left`);
    }
  }
  console.log(`Done: ${processed.toLocaleString()} events, ${matched.toLocaleString()} sets matched, ${sgg.requests.toLocaleString()} start.gg requests. Next: npm run build-tournaments`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("startgg-sync failed:", err);
  process.exit(1);
});
