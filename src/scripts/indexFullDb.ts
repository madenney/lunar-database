/**
 * Index the full-DB zip on storage: store each replay's byte range inside it
 * (Replay.archive, services/fullDbArchive.ts) so the website can serve replay views
 * from storage instead of the home uplink. Reads only the zip's central directory
 * (~390 MB of range reads; storage egress is free).
 *
 *   npm run index-full-db               dry run: how many replays would get a location
 *   npm run index-full-db -- --apply    write them (and clear locations from an older zip)
 *   npm run index-full-db -- --undo     remove every archive location
 *
 * Rerun after each full-DB rebuild: the snapshot id (key@etag) changes, every replay in
 * the new zip gets the new location, and replays no longer in it lose theirs.
 */
import mongoose from "mongoose";
import { connectDb } from "../db";
import { Replay } from "../models/Replay";
import {
  centralDirectory,
  readZipTail,
  replayPathOf,
  snapshotIdOf,
  storageRangeReader,
  type ZipEntry,
} from "../services/fullDbArchive";

const BATCH = 5000;

async function main() {
  const apply = process.argv.includes("--apply");
  const undo = process.argv.includes("--undo");
  await connectDb();
  const col = Replay.collection;

  if (undo) {
    const r = await col.updateMany({ archive: { $exists: true } }, { $unset: { archive: "" } });
    console.log(`Removed archive locations from ${r.modifiedCount.toLocaleString()} replays.`);
    return mongoose.disconnect();
  }

  const started = Date.now();
  const read = storageRangeReader();
  const snap = await snapshotIdOf();
  const tail = await readZipTail(read, snap.size);
  console.log(`${snap.id}: ${(snap.size / 1e12).toFixed(2)} TB, ${tail.entries.toLocaleString()} entries, directory ${(tail.cdSize / 1e6).toFixed(0)} MB`);

  let seen = 0;
  let replays = 0;
  let matched = 0;
  let notStored = 0;
  let checked = 0;
  const missing: string[] = [];
  let batch: { entry: ZipEntry; filePath: string; format: "slpz" | "slp" }[] = [];

  // The data offset assumes the local header repeats the name with no extra field
  // (what Python's zipfile writes). Check real headers before trusting it.
  async function verifyHeaders(sample: ZipEntry[]) {
    for (const en of sample) {
      const nameLen = Buffer.byteLength(en.name);
      const h = await read(en.headerOffset, en.headerOffset + 29);
      if (h.readUInt32LE(0) !== 0x04034b50 || h.readUInt16LE(26) !== nameLen || h.readUInt16LE(28) !== 0) {
        throw new Error(`local header of ${en.name} isn't the expected shape; data offsets would be wrong`);
      }
      checked++;
    }
  }

  async function flush() {
    if (!batch.length) return;
    const docs = await col
      .find({ filePath: { $in: batch.map((b) => b.filePath) } }, { projection: { _id: 1, filePath: 1 } })
      .toArray();
    const byPath = new Map<string, unknown[]>();
    for (const d of docs) {
      const list = byPath.get(d.filePath as string) ?? [];
      list.push(d._id);
      byPath.set(d.filePath as string, list);
    }
    const ops: any[] = [];
    for (const b of batch) {
      const ids = byPath.get(b.filePath);
      if (!ids) {
        if (missing.length < 10) missing.push(b.filePath);
        continue;
      }
      matched += ids.length;
      const archive = { snapshot: snap.id, offset: b.entry.dataOffset, length: b.entry.compressedSize, format: b.format };
      for (const _id of ids) ops.push({ updateOne: { filter: { _id }, update: { $set: { archive } } } });
    }
    if (apply && ops.length) await col.bulkWrite(ops, { ordered: false });
    batch = [];
  }

  for await (const entry of centralDirectory(read, tail.cdOffset, tail.cdSize)) {
    seen++;
    const rp = replayPathOf(entry.name);
    if (!rp) continue;
    replays++;
    if (entry.method !== 0) {
      notStored++;
      continue;
    }
    if (replays <= 20 || replays % 250_000 === 0) await verifyHeaders([entry]);
    batch.push({ entry, ...rp });
    if (batch.length >= BATCH) await flush();
    if (seen % 250_000 === 0) {
      console.log(`  ${seen.toLocaleString()} entries, ${matched.toLocaleString()} replays located (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    }
  }
  await flush();

  let cleared = 0;
  if (apply) {
    const r = await col.updateMany(
      { archive: { $exists: true }, "archive.snapshot": { $ne: snap.id } },
      { $unset: { archive: "" } },
    );
    cleared = r.modifiedCount;
  }
  const total = await col.estimatedDocumentCount();
  console.log(
    `${replays.toLocaleString()} replay entries in the zip (${notStored} not stored plainly, skipped); ` +
      `${matched.toLocaleString()} of ${total.toLocaleString()} replays ${apply ? "located" : "would be located (dry run: add --apply)"}; ` +
      `${checked} local headers checked; ${((Date.now() - started) / 1000).toFixed(0)} s.`,
  );
  if (apply && cleared) console.log(`Cleared ${cleared.toLocaleString()} locations from an older zip.`);
  if (missing.length) console.log(`Zip entries with no replay in the database (first ${missing.length}): ${missing.join(", ")}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
