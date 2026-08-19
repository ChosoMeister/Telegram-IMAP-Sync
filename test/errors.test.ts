import { describe, expect, it } from "vitest";
import { describeError } from "../src/errors.js";

describe("error diagnostics", () => {
  it("includes nested network causes and codes", () => {
    const cause = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    expect(describeError(new Error("fetch failed", { cause }))).toBe("fetch failed <- ECONNREFUSED: connection refused");
  });
});
