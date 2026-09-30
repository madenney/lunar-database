/**
 * A minimal streaming ZIP writer for bundles: stored entries only (.slpz files
 * are already compressed), written to a stream as they are added, so a bundle
 * can go straight to storage without a copy on local disk (any size: the
 * worker's disk no longer limits bundles).
 *
 * Each entry's CRC-32 is computed before it is written (the file is read twice,
 * which is cheap next to the upload), so local headers carry real sizes and
 * CRCs: no data descriptors, which every unzip tool handles. ZIP64 records are
 * added automatically once offsets pass 4 GB or entries pass 65,534, as `zip`
 * itself does.
 */
import fs from "fs";
import zlib from "zlib";
import { PassThrough } from "stream";

const U32 = 0xffffffff;
const U16 = 0xffff;

type Central = { name: Buffer; crc: number; size: number; offset: number };

/** DOS date/time fields for "now" (zip stores local time, 2-second precision). */
function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export class ZipStreamWriter {
  /** The zip bytes; pipe this to storage. */
  readonly stream = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
  private offset = 0;
  private entries: Central[] = [];
  private readonly stamp = dosTime();

  /** For tests: write the ZIP64 structures even for small archives. */
  constructor(private forceZip64 = false) {}

  /** Bytes written so far. */
  get bytesWritten() {
    return this.offset;
  }

  private async write(buf: Buffer) {
    if (this.stream.destroyed) throw new Error("bundle stream closed");
    this.offset += buf.length;
    if (this.stream.write(buf)) return;
    // Wait for the reader to catch up; stop waiting if the stream is torn down
    // (e.g. the upload failed and the bundler destroyed it).
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        this.stream.off("drain", onDrain);
        this.stream.off("close", onClose);
      };
      const onDrain = () => (done(), resolve());
      const onClose = () => (done(), reject(new Error("bundle stream closed")));
      this.stream.on("drain", onDrain);
      this.stream.on("close", onClose);
    });
  }

  private localHeader(name: Buffer, crc: number, size: number): Buffer {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4); // version needed: 2.0
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(0, 8); // stored
    h.writeUInt16LE(this.stamp.time, 10);
    h.writeUInt16LE(this.stamp.date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(size, 18);
    h.writeUInt32LE(size, 22);
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(0, 28);
    return Buffer.concat([h, name]);
  }

  /** Add an in-memory file (e.g. the manifest). */
  async addBuffer(name: string, data: Buffer) {
    if (data.length >= U32) throw new Error("zip entries must be under 4 GB");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data) >>> 0;
    this.entries.push({ name: nameBuf, crc, size: data.length, offset: this.offset });
    await this.write(this.localHeader(nameBuf, crc, data.length));
    await this.write(data);
  }

  /** Add a file from disk (read once for its CRC, then streamed). */
  async addFile(name: string, filePath: string) {
    let crc = 0;
    let size = 0;
    for await (const chunk of fs.createReadStream(filePath)) {
      crc = zlib.crc32(chunk as Buffer, crc);
      size += (chunk as Buffer).length;
    }
    if (size >= U32) throw new Error("zip entries must be under 4 GB");
    const nameBuf = Buffer.from(name, "utf8");
    this.entries.push({ name: nameBuf, crc: crc >>> 0, size, offset: this.offset });
    await this.write(this.localHeader(nameBuf, crc >>> 0, size));
    let written = 0;
    for await (const chunk of fs.createReadStream(filePath)) {
      written += (chunk as Buffer).length;
      await this.write(chunk as Buffer);
    }
    if (written !== size) throw new Error(`${filePath} changed while being added to the bundle`);
  }

  /** Write the central directory and end records, and end the stream. */
  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const bigOffset = this.forceZip64 || e.offset >= U32;
      const extra = bigOffset ? Buffer.alloc(12) : Buffer.alloc(0);
      if (bigOffset) {
        extra.writeUInt16LE(0x0001, 0); // ZIP64 extended information
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(e.offset), 4);
      }
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(bigOffset ? 45 : 20, 4); // made by (MS-DOS/FAT attrs), spec version
      h.writeUInt16LE(bigOffset ? 45 : 20, 6); // version needed
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(this.stamp.time, 12);
      h.writeUInt16LE(this.stamp.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.size, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attrs
      h.writeUInt32LE(0, 38); // external attrs
      h.writeUInt32LE(bigOffset ? U32 : e.offset, 42);
      await this.write(Buffer.concat([h, e.name, extra]));
    }
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    const zip64 = this.forceZip64 || count >= U16 || cdStart >= U32 || cdSize >= U32;
    if (zip64) {
      const zip64EocdOffset = this.offset;
      const r = Buffer.alloc(56);
      r.writeUInt32LE(0x06064b50, 0);
      r.writeBigUInt64LE(44n, 4); // size of the rest of this record
      r.writeUInt16LE(45, 12);
      r.writeUInt16LE(45, 14);
      r.writeUInt32LE(0, 16);
      r.writeUInt32LE(0, 20);
      r.writeBigUInt64LE(BigInt(count), 24);
      r.writeBigUInt64LE(BigInt(count), 32);
      r.writeBigUInt64LE(BigInt(cdSize), 40);
      r.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
      loc.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([r, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(zip64 ? U16 : count, 8);
    end.writeUInt16LE(zip64 ? U16 : count, 10);
    end.writeUInt32LE(zip64 ? U32 : cdSize, 12);
    end.writeUInt32LE(zip64 ? U32 : cdStart, 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
    this.stream.end();
  }
}
