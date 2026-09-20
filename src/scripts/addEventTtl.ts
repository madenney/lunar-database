/**
 * Convert the createdAt index on the analytics-event collections to a TTL index,
 * so SearchEvent/DownloadEvent PII expires after config.analyticsRetentionDays
 * (security review M3). Idempotent — safe to re-run; also fixes the value if the
 * retention config changed.
 *
 * Needed because a pre-existing NON-TTL `createdAt_1` index conflicts with the
 * schema's TTL definition (mongoose can't add expireAfterSeconds to an existing
 * index), so we drop+recreate (or collMod) here rather than on autoIndex.
 *
 * Run:  npx ts-node src/scripts/addEventTtl.ts
 */
import mongoose from "mongoose";
import { config } from "../config";

const DAY = 24 * 60 * 60;

// Keep in lockstep with the model definitions.
const TARGETS: Record<string, number> = {
  searchevents: config.analyticsRetentionDays * DAY,
  // Floored above the full-DB throttle window so expiry never races the throttle.
  downloadevents: Math.max(config.analyticsRetentionDays * DAY, (config.fullDbWindowHours + 24) * 60 * 60),
};

async function convert(collName: string, expireAfterSeconds: number): Promise<void> {
  const coll = mongoose.connection.db!.collection(collName);
  const indexes = await coll.indexes();
  const existing = indexes.find(
    (ix) => ix.key && Object.keys(ix.key).length === 1 && (ix.key as any).createdAt === 1
  );

  if (!existing) {
    await coll.createIndex({ createdAt: 1 }, { expireAfterSeconds });
    console.log(`${collName}: created TTL index (${expireAfterSeconds}s / ${(expireAfterSeconds / DAY).toFixed(0)}d)`);
    return;
  }
  if (existing.expireAfterSeconds === expireAfterSeconds) {
    console.log(`${collName}: TTL index already correct (${(expireAfterSeconds / DAY).toFixed(0)}d) — no change`);
    return;
  }
  if (typeof existing.expireAfterSeconds === "number") {
    // Already a TTL index, just a different window → adjust in place.
    await mongoose.connection.db!.command({
      collMod: collName,
      index: { name: existing.name, expireAfterSeconds },
    });
    console.log(`${collName}: adjusted TTL ${existing.expireAfterSeconds}s → ${expireAfterSeconds}s`);
    return;
  }
  // Plain (non-TTL) index → drop and recreate as TTL.
  await coll.dropIndex(existing.name!);
  await coll.createIndex({ createdAt: 1 }, { expireAfterSeconds });
  console.log(`${collName}: converted plain createdAt index → TTL (${(expireAfterSeconds / DAY).toFixed(0)}d)`);
}

async function main(): Promise<void> {
  await mongoose.connect(config.mongoUri, { autoIndex: false });
  console.log(`Connected. Retention: ${config.analyticsRetentionDays}d\n`);
  for (const [coll, secs] of Object.entries(TARGETS)) {
    await convert(coll, secs);
  }
  console.log("\nDone. MongoDB's TTL monitor will purge expired docs within ~60s.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
