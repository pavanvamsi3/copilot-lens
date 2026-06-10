import { describe, it, expect } from "vitest";
import { parseDigestArgs } from "../cli-digest";

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
