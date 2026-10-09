import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { centralDirectory, parseCentralRecords, readZipTail, replayPathOf, type RangeReader } from "./fullDbArchive";

// A zip made by Python's zipfile, the way scripts/full-db/build_full_db.py makes the
// real one (STORED entries, directory entries included), read back through ranges.
function pythonZip(dir: string, files: Record<string, Buffer>): string {
  for (const [name, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, "src", name)), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", name), data);
  }
  const out = path.join(dir, "full.zip");
  execFileSync("python3", [
    "-c",
    `import zipfile,os,sys
src,out=sys.argv[1],sys.argv[2]
with zipfile.ZipFile(out,"w",compression=zipfile.ZIP_STORED,allowZip64=True) as z:
  for root,dirs,files in sorted(os.walk(src)):
    rel=os.path.relpath(root,src)
    if rel!=".": z.write(root,rel+"/")
    for f in sorted(files): z.write(os.path.join(root,f),os.path.relpath(os.path.join(root,f),src))`,
    path.join(dir, "src"),
    out,
  ]);
  return out;
}

const fileReader = (file: string): RangeReader => async (start, end) => {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(end - start + 1);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
};

describe("full-DB zip reading", () => {
  it("finds every replay's exact bytes, across chunk boundaries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulldb-"));
    const files = {
      "tournament/Genesis 9/Game_1.slpz": Buffer.from("slpz-one ".repeat(40)),
      "tournament/Genesis 9/Game_2.slpz": Buffer.from("slpz-two ".repeat(25)),
      "netplay/ABC#1/Game_3.slp": Buffer.from("raw-slp ".repeat(10)),
      "netplay/ABC#1/notes.txt": Buffer.from("not a replay"),
    };
    const zip = pythonZip(dir, files);
    const read = fileReader(zip);
    const tail = await readZipTail(read, fs.statSync(zip).size);
    const seen: Record<string, Buffer> = {};
    // A tiny chunk forces records to be cut across reads.
    for await (const en of centralDirectory(read, tail.cdOffset, tail.cdSize, 37)) {
      if (!replayPathOf(en.name)) continue;
      expect(en.method).toBe(0);
      seen[en.name] = await read(en.dataOffset, en.dataOffset + en.compressedSize - 1);
    }
    expect(Object.keys(seen).sort()).toEqual(Object.keys(files).filter((n) => n.endsWith(".slp") || n.endsWith(".slpz")).sort());
    for (const [name, data] of Object.entries(seen)) expect(data.equals(files[name as keyof typeof files])).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads ZIP64 offsets and sizes from the extra field", () => {
    const name = Buffer.from("tournament/x/Game.slpz");
    const extra = Buffer.alloc(4 + 24);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(5_000_000_000n, 4); // size
    extra.writeBigUInt64LE(5_000_000_000n, 12); // compressed size
    extra.writeBigUInt64LE(1_200_000_000_000n, 20); // local header offset
    const rec = Buffer.alloc(46);
    rec.writeUInt32LE(0x02014b50, 0);
    rec.writeUInt32LE(0xffffffff, 20);
    rec.writeUInt32LE(0xffffffff, 24);
    rec.writeUInt16LE(name.length, 28);
    rec.writeUInt16LE(extra.length, 30);
    rec.writeUInt32LE(0xffffffff, 42);
    const whole = Buffer.concat([rec, name, extra]);
    const { entries, consumed } = parseCentralRecords(Buffer.concat([whole, whole.subarray(0, 20)]));
    expect(consumed).toBe(whole.length);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ size: 5_000_000_000, compressedSize: 5_000_000_000, headerOffset: 1_200_000_000_000 });
    expect(entries[0].dataOffset).toBe(1_200_000_000_000 + 30 + name.length);
  });

  it("maps entry names to replay paths", () => {
    expect(replayPathOf("tournament/a/Game.slpz")).toEqual({ filePath: "tournament/a/Game.slp", format: "slpz" });
    expect(replayPathOf("netplay/b/Game.slp")).toEqual({ filePath: "netplay/b/Game.slp", format: "slp" });
    expect(replayPathOf("tournament/")).toBeNull();
    expect(replayPathOf("a/notes.txt")).toBeNull();
  });
});
