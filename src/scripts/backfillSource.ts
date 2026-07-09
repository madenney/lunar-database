/**
 * Backfill Replay.source from folderLabel's top-level directory.
 *
 * Every replay was crawled from one of three roots, which IS the source of truth:
 *   netplay/…            -> source "netplay"
 *   ranked_anonymized/…  -> source "ranked"
 *   tournament/…         -> source "tournament"
 *
 * Dry run (default) — reports what WOULD change, touches nothing:
 *   npx ts-node src/scripts/backfillSource.ts
 * Apply:
 *   npx ts-node src/scripts/backfillSource.ts --apply
 *
 * Idempotent: only updates docs whose `source` isn't already correct, so it's
 * safe to re-run (e.g. after a new import batch).
 */
import mongoose from "mongoose";
import { connectDb } from "../db";
import { Replay, ReplaySource } from "../models/Replay";

const MAPPING: { prefix: string; source: ReplaySource }[] = [
  { prefix: "netplay/", source: "netplay" },
  { prefix: "ranked_anonymized/", source: "ranked" },
  { prefix: "tournament/", source: "tournament" },
];

// Escape for use in an anchored regex.
const anchored = (prefix: string) => "^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function main() {
  const apply = process.argv.includes("--apply");
  await connectDb();

  const total = await Replay.estimatedDocumentCount();
  console.log(`${apply ? "APPLYING" : "DRY RUN"} — ${total.toLocaleString()} replays total\n`);

  let totalMatched = 0;
  let totalChanged = 0;

  for (const { prefix, source } of MAPPING) {
    const byPrefix = { folderLabel: { $regex: anchored(prefix) } };
    // Only docs that don't already carry the right source.
    const needsUpdate = { ...byPrefix, source: { $ne: source } };

    const matched = await Replay.countDocuments(byPrefix);
    const pending = await Replay.countDocuments(needsUpdate);
    totalMatched += matched;

    if (!apply) {
      console.log(`  ${prefix.padEnd(22)} -> ${source.padEnd(11)} ${matched.toLocaleString().padStart(10)} match, ${pending.toLocaleString().padStart(10)} need update`);
      continue;
    }

    // folderLabel isn't indexed, so this is a COLLSCAN — but the whole collection
    // is only ~0.4 GB on disk and scans at ~3.9M docs/s, so one pass per prefix
    // beats chipping away in batches (which would re-scan on every batch).
    const started = Date.now();
    const res = await Replay.updateMany(byPrefix, { $set: { source } });
    const changed = res.modifiedCount ?? 0;
    totalChanged += changed;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ${prefix.padEnd(22)} -> ${source.padEnd(11)} ${changed.toLocaleString().padStart(10)} updated in ${secs}s`);
  }

  // Anything the mapping didn't cover is worth knowing about.
  const unmapped = await Replay.countDocuments({ source: null });
  console.log(`\nmatched by prefix: ${totalMatched.toLocaleString()} / ${total.toLocaleString()}`);
  if (apply) console.log(`updated:           ${totalChanged.toLocaleString()}`);
  console.log(`still source=null: ${unmapped.toLocaleString()}${unmapped ? "  <-- investigate" : ""}`);

  if (!apply) console.log("\nNothing was written. Re-run with --apply to commit.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
