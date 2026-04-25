import { describe, it, expect } from "vitest";
import { parseTokensArgs } from "../cli-tokens";

describe("parseTokensArgs", () => {
  it("defaults to source=all, no json, no help", () => {
    expect(parseTokensArgs([])).toEqual({ source: "all", json: false, help: false });
  });

  it("parses --source copilot-cli", () => {
    expect(parseTokensArgs(["--source", "copilot-cli"])).toEqual({
      source: "copilot-cli",
      json: false,
      help: false,
    });
  });

  it("parses --source claude-code", () => {
    expect(parseTokensArgs(["--source", "claude-code"])).toEqual({
      source: "claude-code",
      json: false,
      help: false,
    });
  });

  it("ignores invalid --source values", () => {
    expect(parseTokensArgs(["--source", "bogus"])).toEqual({
      source: "all",
      json: false,
      help: false,
    });
  });

  it("parses --json", () => {
    expect(parseTokensArgs(["--json"]).json).toBe(true);
  });

  it("parses --help and -h", () => {
    expect(parseTokensArgs(["--help"]).help).toBe(true);
    expect(parseTokensArgs(["-h"]).help).toBe(true);
  });

  it("parses combined flags", () => {
    expect(parseTokensArgs(["--source", "claude-code", "--json"])).toEqual({
      source: "claude-code",
      json: true,
      help: false,
    });
  });
});
