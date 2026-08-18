import { describe, expect, it } from "vitest";
import { redact } from "../src/logger.js";

describe("redaction", () => {
  it("redacts secret fields and bearer tokens", () => {
    expect(redact({ password: "abc", nested: "Authorization: Bearer token-value" })).toEqual({ password: "[REDACTED]", nested: "Authorization: Bearer [REDACTED]" });
  });
});
