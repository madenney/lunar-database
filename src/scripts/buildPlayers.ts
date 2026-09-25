import mongoose from "mongoose";
import { Replay } from "../models/Replay";
import { Player } from "../models/Player";
import { connectDb } from "../db";

async function buildPlayers() {
  await connectDb();

  // Rebuild the autocomplete summary. Run after every crawl (npm run build-players):
  // the crawler doesn't maintain it. Counts only usable replays, so a player's
  // gameCount matches what a search for their code returns.
  console.log("Aggregating players from replays...");
  const builtAt = new Date();
  const pipeline = [
    { $match: { usable: true } },
    { $unwind: "$players" },
    { $match: { "players.connectCode": { $ne: null } } },
    {
      $group: {
        _id: "$players.connectCode",
        displayName: { $last: "$players.displayName" },
        tag: { $last: "$players.tag" },
        gameCount: { $sum: 1 },
      },
    },
  ];

  // Collection aliases: each netplay/<name> folder is one player's collection. Its
  // owner is the connect code present in at least half of the folder's games.
  console.log("Finding netplay collection owners...");
  const folder = { $arrayElemAt: [{ $split: ["$folderLabel", "/"] }, 1] };
  const [ownerCounts, folderTotals] = await Promise.all([
    Replay.aggregate([
      { $match: { usable: true, source: "netplay" } },
      { $project: { folder, codes: "$players.connectCode" } },
      { $unwind: "$codes" },
      { $match: { codes: { $ne: null } } },
      { $group: { _id: { f: "$folder", c: "$codes" }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $group: { _id: "$_id.f", code: { $first: "$_id.c" }, n: { $first: "$n" } } },
    ]).allowDiskUse(true),
    Replay.aggregate([
      { $match: { usable: true, source: "netplay" } },
      { $group: { _id: folder, n: { $sum: 1 } } },
    ]).allowDiskUse(true),
  ]);
  const totals = new Map(folderTotals.map((f: any) => [f._id, f.n]));
  const aliases = new Map<string, string[]>();
  for (const o of ownerCounts as any[]) {
    if (!o._id || !o.code || o.n < 0.5 * (totals.get(o._id) ?? Infinity)) continue;
    aliases.set(o.code, [...(aliases.get(o.code) ?? []), o._id].sort());
  }
  console.log(`${aliases.size} players own a netplay collection.`);

  const cursor = Replay.aggregate(pipeline).allowDiskUse(true).cursor({ batchSize: 5000 });

  let upserted = 0;
  let batch: any[] = [];
  const BATCH_SIZE = 1000;

  for await (const doc of cursor) {
    batch.push({
      updateOne: {
        filter: { connectCode: doc._id },
        update: {
          $set: {
            connectCode: doc._id,
            displayName: doc.displayName,
            tag: doc.tag,
            gameCount: doc.gameCount,
            aliases: aliases.get(doc._id) ?? [],
            builtAt,
          },
        },
        upsert: true,
      },
    });

    if (batch.length >= BATCH_SIZE) {
      await Player.bulkWrite(batch);
      upserted += batch.length;
      batch = [];
      console.log(`Upserted: ${upserted}`);
    }
  }

  if (batch.length > 0) {
    await Player.bulkWrite(batch);
    upserted += batch.length;
  }

  // Players with no usable games left (e.g. removed duplicates) drop out. Guard:
  // only if every upserted row really carries this run's timestamp, so a failed
  // write can never wipe the table.
  const fresh = await Player.countDocuments({ builtAt });
  if (upserted === 0 || fresh !== upserted) {
    throw new Error(`Refusing to prune: upserted ${upserted}, rows stamped this run ${fresh}`);
  }
  const stale = await Player.deleteMany({ $or: [{ builtAt: { $lt: builtAt } }, { builtAt: { $exists: false } }] });
  console.log(`Removed ${stale.deletedCount} players with no usable games.`);

  const total = await Player.countDocuments();
  console.log(`Done. Upserted ${upserted} players. Total in collection: ${total}`);
  await mongoose.disconnect();
}

buildPlayers().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
