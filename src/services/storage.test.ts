import { sanitizeDownloadFilename } from "./storage";

// storage.ts imports ../config at module load; stub it so the import doesn't
// require real S3 env. We only exercise the pure filename sanitizer here.
jest.mock("../config", () => ({
  config: { s3Configured: false },
}));

describe("sanitizeDownloadFilename", () => {
  it("keeps a clean name and forces a single .zip extension", () => {
    expect(sanitizeDownloadFilename("lunar-db_Fox.zip")).toBe("lunar-db_Fox.zip");
    expect(sanitizeDownloadFilename("lunar-db_Fox")).toBe("lunar-db_Fox.zip");
  });

  it("does not double up the extension", () => {
    expect(sanitizeDownloadFilename("bundle.zip")).toBe("bundle.zip");
    expect(sanitizeDownloadFilename("bundle.ZIP")).toBe("bundle.zip");
  });

  it("rewrites a legacy .tar name to .zip", () => {
    // The exact bug xpilot hit: a .tar-named object.
    expect(sanitizeDownloadFilename("job123.tar")).toBe("job123.tar.zip");
  });

  it("strips characters that could break the Content-Disposition header", () => {
    // `"`, `;`, and the space each map to one underscore.
    expect(sanitizeDownloadFilename('evil"; drop.zip')).toBe("evil___drop.zip");
    expect(sanitizeDownloadFilename("a/b/c.zip")).toBe("a_b_c.zip");
    expect(sanitizeDownloadFilename("nasty\r\nname")).toBe("nasty__name.zip");
  });

  it("falls back to lunar-db for empty or non-string input", () => {
    expect(sanitizeDownloadFilename("")).toBe("lunar-db.zip");
    expect(sanitizeDownloadFilename("   ")).toBe("lunar-db.zip");
    expect(sanitizeDownloadFilename(undefined)).toBe("lunar-db.zip");
    expect(sanitizeDownloadFilename(null)).toBe("lunar-db.zip");
    expect(sanitizeDownloadFilename(42)).toBe("lunar-db.zip");
    // A name that sanitizes down to nothing but the extension.
    expect(sanitizeDownloadFilename(".zip")).toBe("lunar-db.zip");
  });

  it("caps length", () => {
    const long = "a".repeat(500);
    const out = sanitizeDownloadFilename(long);
    expect(out.endsWith(".zip")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(204);
  });
});
