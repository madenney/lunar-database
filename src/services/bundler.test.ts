import fs from "fs";
import path from "path";
import os from "os";
import { createBundle, cleanupJobTemp } from "./bundler";

// Override config for tests
jest.mock("../config", () => ({
  config: {
    jobTempDir: path.join(os.tmpdir(), "lm-test-job-temp-" + process.pid),
    bundlesDir: path.join(os.tmpdir(), "lm-test-bundles-" + process.pid),
    bundleMaxAgeHours: 0, // expire immediately for cleanup test
    minFreeDiskMb: 100,
    slpzTimeoutMinutes: 30,
  },
}));

// Mock execFile for slpz, tar, df, and du
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
    } else if (cmd === "tar") {
      const cfIndex = args.indexOf("-cf");
      if (cfIndex !== -1) {
        const tarPath = args[cfIndex + 1];
        const sourceDir = args[args.indexOf("-C") + 1];
        const files = fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir) : [];
        fs.writeFileSync(tarPath, `tar-mock: ${files.join(",")}`);
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
  for (const dir of [config.jobTempDir, config.bundlesDir]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
    }
  }
});

describe("bundler", () => {
  describe("createBundle", () => {
    it("creates a tar file from a list of .slp paths", async () => {
      const fixture = path.join(__dirname, "../__fixtures__/test.slp");
      const result = await createBundle([fixture], "aaaaaaaaaaaaaaaaaaaaaaaa");

      expect(result.tarPath).toMatch(/aaaaaaaaaaaaaaaaaaaaaaaa\.tar$/);
      expect(result.size).toBeGreaterThan(0);
      expect(fs.existsSync(result.tarPath)).toBe(true);

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

    it("throws when no files exist", async () => {
      await expect(
        createBundle(["/tmp/nope-does-not-exist.slp"], "cccccccccccccccccccccccc")
      ).rejects.toThrow("No files were compressed for bundling");
    });
  });

  describe("cleanupJobTemp", () => {
    it("cleans up job directory and tar file", async () => {
      const fixture = path.join(__dirname, "../__fixtures__/test.slp");
      const result = await createBundle([fixture], "dddddddddddddddddddddddd");

      expect(fs.existsSync(result.tarPath)).toBe(true);

      cleanupJobTemp("dddddddddddddddddddddddd");
      expect(fs.existsSync(result.tarPath)).toBe(false);
    });

    it("does not throw for non-existent job", () => {
      expect(() => cleanupJobTemp("eeeeeeeeeeeeeeeeeeeeeeee")).not.toThrow();
    });
  });

});
