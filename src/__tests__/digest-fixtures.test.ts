import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SessionMeta } from "../sessions";
import type { TokenUsageAnalytics } from "../token-usage";
const fixture = vi.hoisted(() => ({
  home: "",
  sessions: [] as SessionMeta[],
  daily: [] as TokenUsageAnalytics["daily"],
}));
vi.mock("os", async (original) => ({
  ...(await original<typeof import("os")>()),
  homedir: () => fixture.home,
}));
vi.mock("../sessions", () => ({ listSessions: () => fixture.sessions }));
vi.mock("../token-usage", () => ({
  getTokenUsage: () => ({ daily: fixture.daily }),
}));
import { getDigest, type DigestPeriod } from "../digest";
function session(id: string, createdAt: string, duration = 1000): SessionMeta {
  return {
    id,
    createdAt,
    updatedAt: new Date(new Date(createdAt).getTime() + duration).toISOString(),
    cwd: "/projects/demo",
    status: "completed",
    source: "cli",
    title: id,
  };
}
function day(period: string, total: number) {
  return {
    period,
    calls: 1,
    prompt_tokens: total,
    completion_tokens: 0,
    cached_tokens: 0,
    total_tokens: total,
    top_model: "model-a",
    models: {
      "model-a": {
        prompt_tokens: total,
        completion_tokens: 0,
        cached_tokens: 0,
        total_tokens: total,
      },
    },
  };
}
beforeEach(() => {
  fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), "digest-fixture-"));
  fixture.sessions = [];
  fixture.daily = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-17T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(fixture.home, { recursive: true, force: true });
});
describe("digest fixture aggregation", () => {
  it("asserts exact totals and keeps sessions sharing a creation time distinct", () => {
    fixture.sessions = [
      session("one", "2026-06-15T01:00:00Z", 1000),
      session("two", "2026-06-15T01:00:00Z", 3000),
      session("three", "2026-06-16T01:00:00Z", 2000),
      session("prior", "2026-06-08T01:00:00Z"),
    ];
    fixture.daily = [
      day("2026-06-15", 100),
      day("2026-06-16", 200),
      day("2026-06-08", 50),
      day("2026-06-01", 999),
    ];
    expect(getDigest()).toMatchObject({
      startDate: "2026-06-15",
      endDate: "2026-06-21",
      sessions: 3,
      priorSessions: 1,
      activeDays: 2,
      totalDays: 7,
      totalDurationMs: 6000,
      totalTokens: 300,
      priorTokens: 50,
      topModel: "model-a",
      mostActiveRepo: "demo",
      longestSession: { title: "two", durationMs: 3000, turns: 0 },
    });
  });
  it("returns empty-period totals without inventing a prior token baseline", () => {
    expect(getDigest()).toMatchObject({
      sessions: 0,
      priorSessions: 0,
      activeDays: 0,
      totalDurationMs: 0,
      totalTokens: 0,
      priorTokens: null,
      longestSession: null,
      topTool: null,
      topModel: null,
      mostActiveRepo: null,
      peakHour: null,
    });
  });
  it.each([
    ["2026-06-17", "week", "2026-06-15", "2026-06-21"],
    ["2026-06-15", "week", "2026-06-15", "2026-06-21"],
    ["2026-06-21", "week", "2026-06-15", "2026-06-21"],
    ["2026-06-17", "last-week", "2026-06-08", "2026-06-14"],
    ["2026-01-01", "week", "2025-12-29", "2026-01-04"],
    ["2026-03-01", "week", "2026-02-23", "2026-03-01"],
    ["2024-02-15", "month", "2024-02-01", "2024-02-29"],
    ["2026-02-15", "month", "2026-02-01", "2026-02-28"],
    ["2026-01-15", "month", "2026-01-01", "2026-01-31"],
  ])(
    "uses inclusive UTC boundaries at %s for %s",
    (now, period, start, end) => {
      vi.setSystemTime(new Date(now + "T12:00:00Z"));
      const startMs = Date.parse(start + "T00:00:00Z"),
        endMs = Date.parse(end + "T23:59:59.999Z");
      fixture.sessions = [
        session("before", new Date(startMs - 1).toISOString()),
        session("start", new Date(startMs).toISOString()),
        session("end", new Date(endMs).toISOString()),
        session("after", new Date(endMs + 1).toISOString()),
        { ...session("bad", now), createdAt: "invalid" },
      ];
      expect(getDigest(period as DigestPeriod)).toMatchObject({
        startDate: start,
        endDate: end,
        sessions: 2,
        activeDays: 2,
      });
    }
  );
  it("counts tool calls and turns across the whole log, including before the last MiB", () => {
    fixture.sessions = [session("large", "2026-06-15T01:00:00Z", 60000)];
    const dir = path.join(fixture.home, ".copilot", "session-state", "large");
    fs.mkdirSync(dir, { recursive: true });
    const event = (type: string, timestamp: string, data = {}) =>
      JSON.stringify({ type, timestamp, data });
    fs.writeFileSync(
      path.join(dir, "events.jsonl"),
      [
        event("tool.execution_start", "2026-06-15T01:00:00Z", { tool: "bash" }),
        event("assistant.turn_start", "2026-06-15T01:00:01Z"),
        JSON.stringify({
          type: "assistant.message",
          data: { content: "x".repeat(1100000) },
        }),
        "malformed line",
        event("tool.execution_start", "2026-06-15T01:00:59Z", { tool: "bash" }),
        event("assistant.turn_start", "2026-06-15T01:01:00Z"),
      ].join("\n")
    );
    expect(getDigest()).toMatchObject({
      totalDurationMs: 60000,
      topTool: "Bash",
      topToolCalls: 2,
      longestSession: { turns: 2, durationMs: 60000 },
    });
  });
});
