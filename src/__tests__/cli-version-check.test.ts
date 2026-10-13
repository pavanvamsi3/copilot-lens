import { describe, it, expect } from "vitest";
import { meetsNodeRequirement } from "../cli";

describe("Node.js version check", () => {
  it("rejects Node 16", () => {
    expect(meetsNodeRequirement("16.20.2")).toBe(false);
  });

  it("rejects Node 14", () => {
    expect(meetsNodeRequirement("14.21.3")).toBe(false);
  });

  it("rejects Node 12", () => {
    expect(meetsNodeRequirement("12.22.12")).toBe(false);
  });

  it("rejects Node 18", () => {
    expect(meetsNodeRequirement("18.0.0")).toBe(false);
  });

  it("rejects Node 18 (LTS point release)", () => {
    expect(meetsNodeRequirement("18.19.1")).toBe(false);
  });

  it("accepts Node 20", () => {
    expect(meetsNodeRequirement("20.11.0")).toBe(true);
  });

  it("accepts Node 22", () => {
    expect(meetsNodeRequirement("22.4.1")).toBe(true);
  });

  it("uses the same parsing logic as cli.ts", () => {
    // Verify the actual current Node version passes
    expect(meetsNodeRequirement(process.versions.node)).toBe(true);
  });
});
