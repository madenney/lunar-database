/**
 * Replays straight out of the full-DB zip on storage.
 *
 * The full-DB download (archive/lunar_db_full.zip, ~1.3 TB) holds every replay of its
 * snapshot as a STORED entry (no compression; the .slpz inside is already compressed),
 * so any one replay is a plain byte range of that object. Storage (R2) has no egress fees
 * and serves ranges at datacenter speed, so the website can serve replay views from it
 * instead of the home uplink, which caps the whole site at a few replay views a second.
 *
 * scripts/indexFullDb.ts reads the zip's central directory once and stores each replay's
 * range on the Replay (archive: { snapshot, offset, length, format }). `snapshot` is the
 * object's key + ETag, so offsets from an older zip are never used against a rebuilt one.
 */
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { config } from "../config";
import { getClient, getPresignedRangeUrl } from "./storage";

export const FULL_DB_KEY = "archive/lunar_db_full.zip";

/** Reads [start, end] (inclusive) of the object. */
export type RangeReader = (start: number, end: number) => Promise<Buffer>;

export function storageRangeReader(key = FULL_DB_KEY): RangeReader {
  return async (start, end) => {
    const res = await getClient().send(new GetObjectCommand({ Bucket: config.s3BucketName, Key: key, Range: `bytes=${start}-${end}` }));
    const body = res.Body as { transformToByteArray(): Promise<Uint8Array> };
    return Buffer.from(await body.transformToByteArray());
  };
}

/** key@etag of the object as it is now. */
export async function snapshotIdOf(key = FULL_DB_KEY): Promise<{ id: string; size: number }> {
  const head = await getClient().send(new HeadObjectCommand({ Bucket: config.s3BucketName, Key: key }));
  const etag = String(head.ETag ?? "").replace(/"/g, "");
  return { id: `${key}@${etag}`, size: Number(head.ContentLength ?? 0) };
}

let snapCache: { at: number; id: string | null } | null = null;
/** The current snapshot id, cached 10 minutes (one HEAD per 10 min, not per view). Null if unreachable. */
export async function currentSnapshotId(): Promise<string | null> {
  if (snapCache && Date.now() - snapCache.at < 10 * 60 * 1000) return snapCache.id;
  let id: string | null = null;
  try {
    id = (await snapshotIdOf()).id;
  } catch {
    id = null;
  }
  snapCache = { at: Date.now(), id };
  return id;
}

export function _resetSnapshotCache() {
  snapCache = null;
}

/** Where the central directory is: from the (ZIP64) end-of-central-directory records. */
export async function readZipTail(read: RangeReader, size: number): Promise<{ entries: number; cdOffset: number; cdSize: number }> {
  const tailLen = Math.min(size, 65_557 + 56 + 20);
  const tail = await read(size - tailLen, size - 1);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  let entries = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  const locator = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), eocd);
  if (locator >= 0) {
    const z64At = Number(tail.readBigUInt64LE(locator + 8));
    const rec = await read(z64At, z64At + 55);
    if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error("bad ZIP64 end-of-central-directory record");
    entries = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }
  return { entries, cdOffset, cdSize };
}

export interface ZipEntry {
  name: string;
  /** 0 = stored. */
  method: number;
  compressedSize: number;
  size: number;
  /** Offset of the entry's local header. */
  headerOffset: number;
  /** Offset of the data, assuming the local header repeats the name with no extra field (true for Python's zipfile). */
  dataOffset: number;
}

/** Parse central-directory records from `buf`; returns the entries and how many bytes were consumed (a record cut off at the end is left for the next chunk). */
export function parseCentralRecords(buf: Buffer): { entries: ZipEntry[]; consumed: number } {
  const out: ZipEntry[] = [];
  let p = 0;
  while (p + 46 <= buf.length) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central directory record at +${p}`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const total = 46 + nameLen + extraLen + commentLen;
    if (p + total > buf.length) break;
    const method = buf.readUInt16LE(p + 10);
    let compressedSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    let headerOffset = buf.readUInt32LE(p + 42);
    const nameBuf = buf.subarray(p + 46, p + 46 + nameLen);
    // ZIP64 extended information: present fields follow in this order when their 32-bit slot is 0xffffffff.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = buf.readUInt16LE(e);
      const len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (headerOffset === 0xffffffff) { headerOffset = Number(buf.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    out.push({
      name: nameBuf.toString("utf8"),
      method,
      compressedSize,
      size,
      headerOffset,
      dataOffset: headerOffset + 30 + nameLen,
    });
    p += total;
  }
  return { entries: out, consumed: p };
}

/** Every central-directory entry, read from storage in chunks (the full DB's is ~390 MB). */
export async function* centralDirectory(read: RangeReader, cdOffset: number, cdSize: number, chunk = 16 * 1024 * 1024): AsyncGenerator<ZipEntry> {
  let pos = cdOffset;
  const end = cdOffset + cdSize;
  let carry: Buffer = Buffer.alloc(0);
  while (pos < end) {
    const last = Math.min(end, pos + chunk) - 1;
    const part = await read(pos, last);
    pos = last + 1;
    const buf = carry.length ? Buffer.concat([carry, part]) : part;
    const { entries, consumed } = parseCentralRecords(buf);
    for (const en of entries) yield en;
    carry = buf.subarray(consumed);
  }
  if (carry.length) throw new Error(`central directory ended mid-record (${carry.length} bytes left)`);
}

/** A zip entry name → the Replay.filePath it holds and how it's stored, or null (directories, other files). */
export function replayPathOf(name: string): { filePath: string; format: "slpz" | "slp" } | null {
  if (name.endsWith(".slpz")) return { filePath: `${name.slice(0, -5)}.slp`, format: "slpz" };
  if (name.endsWith(".slp")) return { filePath: name, format: "slp" };
  return null;
}

/** A short-lived URL for the zip; the caller adds `Range: bytes=offset-(offset+length-1)`. */
export function archiveUrl(expiresInSeconds = 600): Promise<string> {
  return getPresignedRangeUrl(FULL_DB_KEY, expiresInSeconds);
}
