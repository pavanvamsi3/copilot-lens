import { describe, it, expect } from "vitest";
import { isValidSessionId } from "../validation";

describe("isValidSessionId", () => {
  it("accepts UUID-like ids", () => {
    expect(isValidSessionId("9f1c2e3a-1234-4abc-9def-0123456789ab")).toBe(true);
    expect(isValidSessionId("sess-001")).toBe(true);
    expect(isValidSessionId("abc_DEF.123")).toBe(true);
  });

  it("rejects path-traversal sequences", () => {
    expect(isValidSessionId("..")).toBe(false);
    expect(isValidSessionId("../../etc/passwd")).toBe(false);
    expect(isValidSessionId("..%2f..%2fetc")).toBe(false);
    expect(isValidSessionId("foo/../bar")).toBe(false);
  });

  it("rejects path separators", () => {
    expect(isValidSessionId("foo/bar")).toBe(false);
    expect(isValidSessionId("foo\\bar")).toBe(false);
    expect(isValidSessionId("/etc/hosts")).toBe(false);
  });

  it("rejects empty, oversized, and non-string input", () => {
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("a".repeat(257))).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId(42)).toBe(false);
  });
});
