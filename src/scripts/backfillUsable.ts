/**
 * Backfill Replay.usable — the materialised NOT_JUNK_QUERY predicate.
 *
 * Evaluating notJunk (an $or on stageId/players.characterId, players.0 exists, and
 * duration > 0) is not indexable, so every search/estimate had to FETCH each
 * candidate doc just to re-check it. On a 2M-row source filter that cost ~1.6s of a
 * ~2.5s estimate — to exclude 0.7% of rows. Storing it as an indexed boolean lets
 * those queries use an index instead.
 *
 * Dry run (default) — reports what WOULD change, touches nothing:
 *   npx ts-node src/scripts/backfillUsable.ts
 * Apply:
 *   npx ts-node src/scripts/backfillUsable.ts --apply
 *
 * Idempotent, and always finishes with an EQUIVALENCE CHECK proving the stored
 * flag matches the live predicate exactly (both directions).
 */
import mongoose from "mongoose";
import { connectDb } from "../db";
import { Replay, NOT_JUNK_QUERY } from "../models/Replay";

const notJunk = NOT_JUNK_QUERY as Record<string, unknown>;
const isJunk = { $nor: [notJunk] };

async function main() {
  const apply = process.argv.includes("--apply");
  await connectDb();

  const total = await Replay.estimatedDocumentCount();
  const usableCount = await Replay.countDocuments(notJunk);
  const junkCount = total - usableCount;
  console.log(`${apply ? "APPLYING" : "DRY RUN"} — ${total.toLocaleString()} replays`);
  console.log(`  pass notJunk (usable=true) : ${usableCount.toLocaleString()}`);
  console.log(`  fail notJunk (usable=false): ${junkCount.toLocaleString()} (${((100 * junkCount) / total).toFixed(2)}%)\n`);

  if (!apply) {
    const pendingTrue = await Replay.countDocuments({ ...notJunk, usable: { $ne: true } });
    const pendingFalse = await Replay.countDocuments({ ...isJunk, usable: { $ne: false } });
    console.log(`  need usable=true : ${pendingTrue.toLocaleString()}`);
    console.log(`  need usable=false: ${pendingFalse.toLocaleString()}`);
    console.log("\nNothing was written. Re-run with --apply to commit.");
    await mongoose.disconnect();
    return;
  }

  let t = Date.now();
  const rTrue = await Replay.updateMany(notJunk, { $set: { usable: true } });
  console.log(`  usable=true  ${(rTrue.modifiedCount ?? 0).toLocaleString().padStart(10)} updated in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  t = Date.now();
  const rFalse = await Replay.updateMany(isJunk, { $set: { usable: false } });
  console.log(`  usable=false ${(rFalse.modifiedCount ?? 0).toLocaleString().padStart(10)} updated in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  // EQUIVALENCE CHECK — the stored flag must agree with the live predicate in both
  // directions, or every search/estimate/download would silently change behaviour.
  const [falseNegatives, falsePositives, unset] = await Promise.all([
    Replay.countDocuments({ ...notJunk, usable: { $ne: true } }), // usable says junk, predicate says fine
    Replay.countDocuments({ ...isJunk, usable: true }),           // usable says fine, predicate says junk
    Replay.countDocuments({ usable: null }),
  ]);

  console.log(`\nEQUIVALENCE CHECK`);
  console.log(`  usable=true  but fails notJunk: ${falsePositives.toLocaleString()}`);
  console.log(`  passes notJunk but not usable=true: ${falseNegatives.toLocaleString()}`);
  console.log(`  usable still null: ${unset.toLocaleString()}`);
  const ok = falsePositives === 0 && falseNegatives === 0 && unset === 0;
  console.log(ok ? "  ✓ EXACT MATCH — safe to query on `usable`" : "  ✗ MISMATCH — do NOT swap the query predicate");
  if (!ok) process.exitCode = 1;

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
