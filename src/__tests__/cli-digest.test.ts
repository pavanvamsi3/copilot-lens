import { describe, it, expect } from "vitest";
import { parseDigestArgs } from "../cli-digest";
import { getDigest } from "../digest";

describe("parseDigestArgs", () => {
  it("defaults to week period, no flags", () => {
    expect(parseDigestArgs([])).toEqual({ period: "week", save: false, json: false, help: false });
  });

  it("parses --last-week", () => {
    expect(parseDigestArgs(["--last-week"]).period).toBe("last-week");
  });

  it("parses --month", () => {
    expect(parseDigestArgs(["--month"]).period).toBe("month");
  });

  it("parses --save", () => {
    expect(parseDigestArgs(["--save"]).save).toBe(true);
  });

  it("parses --json", () => {
    expect(parseDigestArgs(["--json"]).json).toBe(true);
  });

  it("parses --help and -h", () => {
    expect(parseDigestArgs(["--help"]).help).toBe(true);
    expect(parseDigestArgs(["-h"]).help).toBe(true);
  });

  it("parses combined flags", () => {
    expect(parseDigestArgs(["--last-week", "--save", "--json"])).toEqual({
      period: "last-week",
      save: true,
      json: true,
      help: false,
    });
  });

  it("last flag wins for period", () => {
    expect(parseDigestArgs(["--month", "--last-week"]).period).toBe("last-week");
  });
});

describe("getDigest", () => {
  it("returns all required fields for week period", () => {
    const data = getDigest("week");
    expect(typeof data.rangeLabel).toBe("string");
    expect(data.rangeLabel.length).toBeGreaterThan(0);
    expect(typeof data.activeDays).toBe("number");
    expect(typeof data.totalDays).toBe("number");
    expect(typeof data.sessions).toBe("number");
    expect(typeof data.totalDurationMs).toBe("number");
    expect(typeof data.totalTokens).toBe("number");
    expect(typeof data.priorSessions).toBe("number");
  });

  it("week totalDays is always 7", () => {
    expect(getDigest("week").totalDays).toBe(7);
    expect(getDigest("last-week").totalDays).toBe(7);
  });

  it("rangeLabel contains 'Week of' for week periods", () => {
    expect(getDigest("week").rangeLabel).toMatch(/Week of/);
    expect(getDigest("last-week").rangeLabel).toMatch(/Week of/);
  });

  it("month totalDays is between 28 and 31", () => {
    const data = getDigest("month");
    expect(data.totalDays).toBeGreaterThanOrEqual(28);
    expect(data.totalDays).toBeLessThanOrEqual(31);
  });

  it("priorTokens is null or a non-negative number", () => {
    const data = getDigest("week");
    expect(data.priorTokens === null || typeof data.priorTokens === "number").toBe(true);
    if (data.priorTokens !== null) expect(data.priorTokens).toBeGreaterThanOrEqual(0);
  });

  it("longestSession is null or has the correct shape", () => {
    const data = getDigest("week");
    if (data.longestSession !== null) {
      expect(typeof data.longestSession.durationMs).toBe("number");
      expect(typeof data.longestSession.turns).toBe("number");
      expect(data.longestSession.durationMs).toBeGreaterThan(0);
    }
  });

  it("startDate and endDate are valid ISO date strings", () => {
    const data = getDigest("week");
    expect(data.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(data.startDate).getTime()).toBeLessThanOrEqual(new Date(data.endDate).getTime());
  });
});
