import path from "path";
import { parseSlpFile } from "./slpParser";

const FIXTURE = path.join(__dirname, "../__fixtures__/test.slp");

describe("slpParser", () => {
  it("parses a .slp file and returns metadata", () => {
    const result = parseSlpFile(FIXTURE);

    expect(result).toHaveProperty("stageId");
    expect(result).toHaveProperty("stageName");
    expect(result).toHaveProperty("startAt");
    expect(result).toHaveProperty("duration");
    expect(result).toHaveProperty("players");
    expect(result).toHaveProperty("winner");
  });

  it("returns an array of players", () => {
    const result = parseSlpFile(FIXTURE);

    expect(Array.isArray(result.players)).toBe(true);
    expect(result.players.length).toBeGreaterThan(0);
  });

  it("each player has expected fields", () => {
    const result = parseSlpFile(FIXTURE);

    for (const player of result.players) {
      expect(player).toHaveProperty("playerIndex");
      expect(player).toHaveProperty("connectCode");
      expect(player).toHaveProperty("displayName");
      expect(player).toHaveProperty("tag");
      expect(player).toHaveProperty("characterId");
      expect(player).toHaveProperty("characterName");
    }
  });

  it("returns a valid stage name", () => {
    const result = parseSlpFile(FIXTURE);

    if (result.stageId != null) {
      expect(typeof result.stageName).toBe("string");
      expect(result.stageName!.length).toBeGreaterThan(0);
    }
  });

  it("returns a valid date", () => {
    const result = parseSlpFile(FIXTURE);

    if (result.startAt) {
      expect(result.startAt).toBeInstanceOf(Date);
      expect(result.startAt.getTime()).not.toBeNaN();
    }
  });

  it("returns duration as a number", () => {
    const result = parseSlpFile(FIXTURE);

    if (result.duration != null) {
      expect(typeof result.duration).toBe("number");
      expect(result.duration).toBeGreaterThan(0);
    }
  });

  it("throws on a non-existent file", () => {
    expect(() => parseSlpFile("/tmp/does-not-exist.slp")).toThrow();
  });
});
