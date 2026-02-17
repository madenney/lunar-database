import fs from "fs";
import path from "path";
import os from "os";
import { createBundle, cleanupJobTemp, cleanupOldBundles } from "./bundler";

// Override config for tests
jest.mock("../config", () => ({
  config: {
    jobTempDir: path.join(os.tmpdir(), "lm-test-job-temp-" + process.pid),
    bundlesDir: path.join(os.tmpdir(), "lm-test-bundles-" + process.pid),
    bundleMaxAgeHours: 0, // expire immediately for cleanup test
  },
}));

// Mock execFile for slpz and tar
jest.mock("child_process", () => ({
  execFile: jest.fn((cmd: string, args: string[], callback: Function) => {
    const { config } = require("../config");

    if (cmd === "slpz") {
      // Simulate slpz: rename .slp files to .slpz in the target dir
      const targetDir = args[args.length - 1];
      if (fs.existsSync(targetDir)) {
        for (const file of fs.readdirSync(targetDir)) {
          if (file.endsWith(".slp")) {
            const oldPath = path.join(targetDir, file);
            const newPath = path.join(targetDir, file.replace(/\.slp$/, ".slpz"));
            fs.renameSync(oldPath, newPath);
          }
        }
      }
      callback(null, { stdout: "", stderr: "" });
    } else if (cmd === "tar") {
      // Simulate tar: create a dummy tar file
      const cfIndex = args.indexOf("-cf");
      if (cfIndex !== -1) {
        const tarPath = args[cfIndex + 1];
        const sourceDir = args[args.indexOf("-C") + 1];
        // Write a simple file with the contents to simulate a tar
        const files = fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir) : [];
        fs.writeFileSync(tarPath, `tar-mock: ${files.join(",")}`);
      }
      callback(null, { stdout: "", stderr: "" });
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
      const result = await createBundle([fixture], "test-job-1");

      expect(result.tarPath).toMatch(/test-job-1\.tar$/);
      expect(result.size).toBeGreaterThan(0);
      expect(fs.existsSync(result.tarPath)).toBe(true);

      // Clean up
      cleanupJobTemp("test-job-1");
    });

    it("calls progress callback during copy", async () => {
      const fixture = path.join(__dirname, "../__fixtures__/test.slp");
      const progress = jest.fn();

      await createBundle([fixture], "test-job-progress", progress);
      // Should be called at least once (final call after all copies)
      expect(progress).toHaveBeenCalled();
      const lastCall = progress.mock.calls[progress.mock.calls.length - 1];
      expect(lastCall[0]).toBe(1); // 1 file processed
      expect(lastCall[1]).toBe(1); // 1 file total

      cleanupJobTemp("test-job-progress");
    });

    it("throws when no files exist", async () => {
      await expect(
        createBundle(["/tmp/nope-does-not-exist.slp"], "test-job-empty")
      ).rejects.toThrow("No files were copied for bundling");
    });
  });

  describe("cleanupJobTemp", () => {
    it("cleans up job directory and tar file", async () => {
      const fixture = path.join(__dirname, "../__fixtures__/test.slp");
      const result = await createBundle([fixture], "test-job-cleanup");

      expect(fs.existsSync(result.tarPath)).toBe(true);

      cleanupJobTemp("test-job-cleanup");
      expect(fs.existsSync(result.tarPath)).toBe(false);
    });

    it("does not throw for non-existent job", () => {
      expect(() => cleanupJobTemp("nonexistent-job")).not.toThrow();
    });
  });

  describe("cleanupOldBundles", () => {
    it("returns 0 when bundles dir doesn't exist", () => {
      const origDir = config.bundlesDir;
      config.bundlesDir = "/tmp/lm-nonexistent-dir-" + process.pid;

      const cleaned = cleanupOldBundles();
      expect(cleaned).toBe(0);

      config.bundlesDir = origDir;
    });
  });
});
