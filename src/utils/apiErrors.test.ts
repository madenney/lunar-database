import { classifyStorageError } from "../services/storage";

describe("classifyStorageError", () => {
  const err = (status: number, name = "", message = "") => ({ name, message, $metadata: { httpStatusCode: status } });

  it("reports the B2 daily cap only for a cap-exceeded refusal", () => {
    expect(classifyStorageError(err(403, "AccessDenied", "download cap exceeded"))).toBe("cap");
    expect(classifyStorageError(err(429, "", "transaction cap exceeded"))).toBe("cap");
  });

  it("treats 503 and SlowDown as transient, not the cap", () => {
    expect(classifyStorageError(err(503, "ServiceUnavailable"))).toBe("busy");
    expect(classifyStorageError({ name: "SlowDown" })).toBe("busy");
  });

  it("recognises missing objects and leaves the rest as other", () => {
    expect(classifyStorageError(err(404, "NotFound"))).toBe("notfound");
    expect(classifyStorageError(err(403, "AccessDenied", "signature mismatch"))).toBe("other");
  });
});
