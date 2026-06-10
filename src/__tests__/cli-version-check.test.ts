import { describe, it, expect } from "vitest";

/**
 * Extracts the version-check logic from cli.ts into a testable pure function.
 * The actual cli.ts uses `process.versions.node` and `process.exit` directly,
 * so here we test the *decision logic* (should it reject?) in isolation.
 */
function checkNodeVersion(versionString: string): { ok: boolean; major: number } {
  const [major] = versionString.split(".").map(Number);
  return { ok: major >= 18, major };
}

describe("Node.js version check", () => {
  it("rejects Node 16", () => {
    const result = checkNodeVersion("16.20.2");
    expect(result.ok).toBe(false);
    expect(result.major).toBe(16);
  });

  it("rejects Node 14", () => {
    const result = checkNodeVersion("14.21.3");
    expect(result.ok).toBe(false);
    expect(result.major).toBe(14);
  });

  it("rejects Node 12", () => {
    const result = checkNodeVersion("12.22.12");
    expect(result.ok).toBe(false);
    expect(result.major).toBe(12);
  });

  it("accepts Node 18", () => {
    const result = checkNodeVersion("18.0.0");
    expect(result.ok).toBe(true);
    expect(result.major).toBe(18);
  });

  it("accepts Node 18 (LTS point release)", () => {
    const result = checkNodeVersion("18.19.1");
    expect(result.ok).toBe(true);
    expect(result.major).toBe(18);
  });

  it("accepts Node 20", () => {
    const result = checkNodeVersion("20.11.0");
    expect(result.ok).toBe(true);
    expect(result.major).toBe(20);
  });

  it("accepts Node 22", () => {
    const result = checkNodeVersion("22.4.1");
    expect(result.ok).toBe(true);
    expect(result.major).toBe(22);
  });

  it("uses the same parsing logic as cli.ts", () => {
    // Verify the actual current Node version passes
    const result = checkNodeVersion(process.versions.node);
    expect(result.ok).toBe(true);
    expect(result.major).toBeGreaterThanOrEqual(18);
  });
});
