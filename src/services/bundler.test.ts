import fs from "fs";
import path from "path";
import os from "os";
import { createBundle, cleanupJobTemp } from "./bundler";

// Override config for tests
jest.mock("../config", () => ({
  config: {
    jobTempDir: path.join(os.tmpdir(), "lm-test-job-temp-" + process.pid),
    minFreeDiskMb: 100,
    slpzBinary: "slpz",
    slpzTimeoutMinutes: 30,
  },
}));

// Mock execFile for slpz, zip, df, and du
jest.mock("child_process", () => ({
  execFile: jest.fn((cmd: string, args: string[], ...rest: any[]) => {
    // Support both (cmd, args, callback) and (cmd, args, opts, callback) signatures
    const callback = typeof rest[rest.length - 1] === "function" ? rest[rest.length - 1] : undefined;
    if (!callback) {
      // promisify path — return via callback style anyway (promisify wraps it)
      throw new Error(`execFile mock: no callback for ${cmd}`);
    }

    if (cmd === "slpz") {
      // Simulate slpz -x -o <output.slpz> <input.slp>
      const oIndex = args.indexOf("-o");
      if (oIndex !== -1) {
        const outPath = args[oIndex + 1];
        const inPath = args[oIndex + 2];
        if (inPath && fs.existsSync(inPath)) {
          // Write a small mock .slpz file
          fs.writeFileSync(outPath, fs.readFileSync(inPath));
        } else {
          callback(new Error(`No such file: ${inPath}`));
          return;
        }
      }
      callback(null, { stdout: "", stderr: "" });
    } else if (cmd === "zip") {
      // bundler runs: zip -0 -r -q <output.zip> .   (cwd = the job's .slpz dir).
      // Match on the .zip arg so this is robust to flag order.
      const zipPath = args.find((a) => a.endsWith(".zip"));
      if (zipPath) fs.writeFileSync(zipPath, "zip-mock");
      // Record what would be zipped so tests can inspect the bundle contents.
      const cwd = rest.length > 1 ? rest[0]?.cwd : undefined;
      if (cwd) {
        (global as any).lastZipContents = Object.fromEntries(
          fs.readdirSync(cwd).map((f: string) => [f, fs.readFileSync(path.join(cwd, f), "utf8")]),
        );
      }
      callback(null, { stdout: "", stderr: "" });
    } else if (cmd === "df") {
      // Return plenty of free space (10GB)
      callback(null, { stdout: "     Avail\n10737418240\n", stderr: "" });
    } else if (cmd === "du") {
      callback(null, { stdout: "1024\t" + args[args.length - 1], stderr: "" });
    } else {
      callback(new Error(`Unexpected command: ${cmd}`));
    }
  }),
}));

const { config } = require("../config");

afterAll(() => {
  // Clean up test dirs
  for (const dir of [config.jobTempDir]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
    }
  }
});

describe("bundler", () => {
  describe("createBundle", () => {
    it("creates a zip file from a list of .slp paths", async () => {
      const fixture = path.join(__dirname, "../__fixtures__/test.slp");
      const result = await createBundle([fixture], "aaaaaaaaaaaaaaaaaaaaaaaa");

      expect(result.zipPath).toMatch(/aaaaaaaaaaaaaaaaaaaaaaaa\.zip$/);
      expect(result.size).toBeGreaterThan(0);
      expect(fs.existsSync(result.zipPath)).toBe(true);

      // Clean up
      cleanupJobTemp("aaaaaaaaaaaaaaaaaaaaaaaa");
    });

    it("calls progress callback during copy", async () => {
      const fixture = path.join(__dirname, "../__fixtures__/test.slp");
      const progress = jest.fn();

      await createBundle([fixture], "bbbbbbbbbbbbbbbbbbbbbbbb", progress);
      // Should be called at least once (final call after all copies)
      expect(progress).toHaveBeenCalled();
      const lastCall = progress.mock.calls[progress.mock.calls.length - 1];
      expect(lastCall[0]).toBe(1); // 1 file processed
      expect(lastCall[1]).toBe(1); // 1 file total

      cleanupJobTemp("bbbbbbbbbbbbbbbbbbbbbbbb");
    });

    it("writes a manifest mapping each file to its replay id and hash", async () => {
      const fixture = path.join(__dirname, "../__fixtures__/test.slp");
      await createBundle(
        [{ filePath: fixture, replayId: "65f000000000000000000001", fileHash: "abc123" }],
        "eeeeeeeeeeeeeeeeeeeeeeee",
      );
      const contents = (global as any).lastZipContents as Record<string, string>;
      const manifest = JSON.parse(contents["lunar-manifest.json"]);
      expect(manifest).toEqual({
        version: 1,
        replays: [{ file: "0_test.slpz", replayId: "65f000000000000000000001", fileHash: "abc123" }],
      });
      expect(Object.keys(contents)).toContain("0_test.slpz");
      cleanupJobTemp("eeeeeeeeeeeeeeeeeeeeeeee");
    });

    it("throws when no files exist", async () => {
      await expect(
        createBundle(["/tmp/nope-does-not-exist.slp"], "cccccccccccccccccccccccc")
      ).rejects.toThrow("No files were compressed for bundling");
    });
  });

  describe("cleanupJobTemp", () => {
    it("cleans up job directory and zip file", async () => {
      const fixture = path.join(__dirname, "../__fixtures__/test.slp");
      const result = await createBundle([fixture], "dddddddddddddddddddddddd");

      expect(fs.existsSync(result.zipPath)).toBe(true);

      cleanupJobTemp("dddddddddddddddddddddddd");
      expect(fs.existsSync(result.zipPath)).toBe(false);
    });

    it("does not throw for non-existent job", () => {
      expect(() => cleanupJobTemp("eeeeeeeeeeeeeeeeeeeeeeee")).not.toThrow();
    });
  });

});
