import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { ZipStreamWriter } from "./zipStream";

// Writes real archives and checks them with the system's unzip and Python's
// zipfile, for both the normal and the ZIP64 layouts.
async function build(forceZip64: boolean, dir: string) {
  const files: string[] = [];
  for (let i = 0; i < 3; i++) {
    const f = path.join(dir, `in${i}.slpz`);
    fs.writeFileSync(f, Buffer.alloc(100_000 + i * 12_345, i + 1));
    files.push(f);
  }
  const w = new ZipStreamWriter(forceZip64);
  const out = path.join(dir, forceZip64 ? "b64.zip" : "b.zip");
  const done = new Promise<void>((resolve, reject) => w.stream.pipe(fs.createWriteStream(out)).on("finish", resolve).on("error", reject));
  for (const [i, f] of files.entries()) await w.addFile(`${i}_game.slpz`, f);
  await w.addBuffer("lunar-manifest.json", Buffer.from(JSON.stringify({ version: 1, replays: [] })));
  await w.finish();
  await done;
  expect(fs.statSync(out).size).toBe(w.bytesWritten);
  return out;
}

describe("ZipStreamWriter", () => {
  let dir: string;
  beforeAll(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "zipstream-"))));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const zip64 of [false, true]) {
    it(`writes an archive unzip and Python both accept${zip64 ? " (ZIP64)" : ""}`, async () => {
      const out = await build(zip64, dir);
      expect(execFileSync("unzip", ["-tq", out]).toString()).toMatch(/No errors detected/);
      const py = execFileSync("python3", ["-c", `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); z.testzip() is None or sys.exit(1); print(len(z.namelist()), sum(i.file_size for i in z.infolist()))`, out]).toString().trim();
      expect(py).toBe(`4 ${100_000 + 112_345 + 124_690 + JSON.stringify({ version: 1, replays: [] }).length}`);
    });
  }
});

describe("ZipStreamWriter teardown", () => {
  it("stops waiting when the stream is destroyed mid-write (e.g. the upload failed)", async () => {
    const w = new ZipStreamWriter();
    const big = Buffer.alloc(8 * 1024 * 1024); // over the stream's buffer, so the write waits
    const pending = w.addBuffer("x.bin", big);
    setTimeout(() => w.stream.destroy(), 10);
    await expect(pending).rejects.toThrow("bundle stream closed");
  });
});
