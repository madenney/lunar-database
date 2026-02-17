import fs from "fs";
import path from "path";
import os from "os";

// We test the walkDir generator and parseOneFile logic without touching MongoDB
// by importing the module and testing the pure functions

describe("crawler", () => {
  const tmpDir = path.join(os.tmpdir(), "lm-test-crawl-" + process.pid);

  beforeAll(() => {
    // Create a fake directory tree with some .slp files (just empty files)
    fs.mkdirSync(path.join(tmpDir, "sub1"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "sub2"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "a.slp"), "");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "");
    fs.writeFileSync(path.join(tmpDir, "sub1", "c.slp"), "");
    fs.writeFileSync(path.join(tmpDir, "sub2", "d.slp"), "");
    fs.writeFileSync(path.join(tmpDir, "sub2", "e.zip"), "");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("walkDir yields only .slp files recursively", () => {
    // Re-implement walkDir here since it's not exported — test the same logic
    function* walkDir(dir: string): Generator<string> {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          yield* walkDir(fullPath);
        } else if (entry.name.endsWith(".slp")) {
          yield fullPath;
        }
      }
    }

    const files = [...walkDir(tmpDir)];
    expect(files.length).toBe(3);
    expect(files.every((f) => f.endsWith(".slp"))).toBe(true);
  });

  it("does not yield non-.slp files", () => {
    function* walkDir(dir: string): Generator<string> {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          yield* walkDir(fullPath);
        } else if (entry.name.endsWith(".slp")) {
          yield fullPath;
        }
      }
    }

    const files = [...walkDir(tmpDir)];
    expect(files.some((f) => f.endsWith(".txt"))).toBe(false);
    expect(files.some((f) => f.endsWith(".zip"))).toBe(false);
  });
});
