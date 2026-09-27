/**
 * Group tournament replays into tournaments (services/tournaments.ts): by their
 * set's start.gg or Jungle identity, else by folder (config/tournamentSeries.json).
 * Online games belong to a tournament only through a matched set (startgg-sync).
 * Writes Replay.tournamentKey and one summary per tournament. Run after
 * build-sets: npm run build-tournaments
 */
import mongoose from "mongoose";
import { connectDb } from "../db";
import { Replay } from "../models/Replay";
import { TournamentSet } from "../models/TournamentSet";
import { Tournament } from "../models/Tournament";
import { tournamentFromPath, type TournamentRef } from "../services/tournaments";
import { EARLIEST_REPLAY_DATE } from "../services/slpParser";

type Acc = {
  ref: TournamentRef;
  location: string | null;
  games: number;
  sets: Set<string>;
  firstAt: Date | null;
  lastAt: Date | null;
  players: Map<string, number>;
  characters: Map<number, number>;
  stages: Map<number, number>;
};

const top = <K>(m: Map<K, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

async function main() {
  await connectDb();
  const builtAt = new Date();
  const started = Date.now();
  const setInfo = new Map<string, { ref: TournamentRef; location: string | null; names: string[] }>();
  for await (const s of TournamentSet.find().select({ tournament: 1, location: 1, players: 1 }).lean().cursor()) {
    setInfo.set(String(s._id), { ref: s.tournament, location: s.location ?? null, names: (s.players ?? []).map((p: any) => p.name) });
  }
  console.log(`${setInfo.size.toLocaleString()} sets loaded`);

  const accs = new Map<string, Acc>();
  let ops: any[] = [];
  let seen = 0;
  let changed = 0;
  // Tournament-folder games, online games in a matched set, and anything grouped
  // before (so a game whose set went away loses its key).
  const cursor = Replay.find({ $or: [{ source: "tournament" }, { setId: { $type: "string" } }, { tournamentKey: { $type: "string" } }] })
    .select({ filePath: 1, setId: 1, startAt: 1, stageId: 1, usable: 1, tournamentKey: 1, "players.characterId": 1, "players.displayName": 1, "players.tag": 1 })
    .lean()
    .cursor({ batchSize: 5000 });
  for await (const r of cursor) {
    seen++;
    const set = r.setId ? setInfo.get(r.setId) : undefined;
    const ref = set?.ref ?? tournamentFromPath(r.filePath);
    const key = ref?.key ?? null;
    if ((r.tournamentKey ?? null) !== key) {
      ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: { tournamentKey: key } } } });
      changed++;
    }
    if (ops.length >= 2000) {
      await Replay.collection.bulkWrite(ops, { ordered: false });
      ops = [];
    }
    if (!ref || !r.usable) continue;
    let a = accs.get(ref.key);
    if (!a) {
      a = { ref, location: null, games: 0, sets: new Set(), firstAt: null, lastAt: null, players: new Map(), characters: new Map(), stages: new Map() };
      accs.set(ref.key, a);
    }
    if (!a.ref.listed && ref.listed) a.ref = ref;
    a.games++;
    if (r.setId) a.sets.add(r.setId);
    if (set?.location && !a.location) a.location = set.location;
    if (r.startAt && r.startAt >= EARLIEST_REPLAY_DATE) {
      if (!a.firstAt || r.startAt < a.firstAt) a.firstAt = r.startAt;
      if (!a.lastAt || r.startAt > a.lastAt) a.lastAt = r.startAt;
    }
    const names = set?.names?.length ? set.names : (r.players ?? []).map((p: any) => p.displayName || p.tag).filter(Boolean);
    for (const n of names) a.players.set(n, (a.players.get(n) ?? 0) + 1);
    for (const p of r.players ?? []) if (p.characterId != null) a.characters.set(p.characterId, (a.characters.get(p.characterId) ?? 0) + 1);
    if (r.stageId != null) a.stages.set(r.stageId, (a.stages.get(r.stageId) ?? 0) + 1);
    if (seen % 100_000 === 0) console.log(`${seen.toLocaleString()} replays, ${accs.size.toLocaleString()} tournaments`);
  }
  if (ops.length) await Replay.collection.bulkWrite(ops, { ordered: false });

  const docs = [...accs.values()].map((a) => ({
    _id: a.ref.key,
    name: a.ref.name,
    listed: a.ref.listed,
    startggSlug: a.ref.startggSlug ?? null,
    location: a.location,
    firstAt: a.firstAt,
    lastAt: a.lastAt,
    games: a.games,
    sets: a.sets.size,
    players: top(a.players, 64).map(([name, games]) => ({ name, games })),
    characters: top(a.characters, 26).map(([characterId, games]) => ({ characterId, games })),
    stages: top(a.stages, 30).map(([stageId, games]) => ({ stageId, games })),
    builtAt,
  }));
  for (let i = 0; i < docs.length; i += 1000) {
    await Tournament.collection.bulkWrite(
      docs.slice(i, i + 1000).map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })) as any,
      { ordered: false }
    );
  }
  const stale = await Tournament.deleteMany({ builtAt: { $lt: builtAt } });
  await Tournament.syncIndexes();
  console.log(
    `Done in ${((Date.now() - started) / 1000).toFixed(0)}s: ${seen.toLocaleString()} replays, ${changed.toLocaleString()} regrouped, ` +
      `${docs.length.toLocaleString()} tournaments (${docs.filter((d) => d.listed).length.toLocaleString()} listed), ${stale.deletedCount} stale removed.`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("build-tournaments failed:", err);
  process.exit(1);
});
