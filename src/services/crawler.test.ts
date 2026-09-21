import { Replay } from "../models/Replay";
import { saveBatch } from "./crawler";

// L5: the crawler must skip duplicate-key errors but never swallow real ones.
describe("crawler saveBatch — non-duplicate error handling (L5)", () => {
  let insertSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    insertSpy = jest.spyOn(Replay, "insertMany").mockResolvedValue([] as any);
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    insertSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("reports no errors on success", async () => {
    expect(await saveBatch([{}])).toEqual({ nonDupErrors: 0 });
  });

  it("silently skips an all-duplicate batch", async () => {
    insertSpy.mockRejectedValue({ writeErrors: [{ code: 11000 }, { code: 11000 }] });
    expect(await saveBatch([{}, {}])).toEqual({ nonDupErrors: 0 });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("surfaces + counts real errors mixed with dups, without throwing", async () => {
    insertSpy.mockRejectedValue({
      writeErrors: [{ code: 11000 }, { code: 121, errmsg: "doc failed validation" }],
    });
    expect(await saveBatch([{}, {}])).toEqual({ nonDupErrors: 1 });
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("re-throws a non-bulk error that isn't a duplicate", async () => {
    insertSpy.mockRejectedValue({ code: 91, message: "connection lost" });
    await expect(saveBatch([{}])).rejects.toBeDefined();
  });

  it("skips a lone duplicate error with no writeErrors array", async () => {
    insertSpy.mockRejectedValue({ code: 11000 });
    expect(await saveBatch([{}])).toEqual({ nonDupErrors: 0 });
  });
});
