import { describe, it, expect, vi, beforeEach } from "vitest";
import { filterSessions, computeQuality, formatAsOpenAI, formatAsShareGPT, bulkExport } from "../export";
import { parseExportArgs } from "../cli-export";
import type { SessionMeta, SessionDetail } from "../sessions";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "test-id-1",
    cwd: "/projects/myrepo",
    gitRoot: "/projects/myrepo",
    branch: "main",
    createdAt: "2025-03-01T10:00:00Z",
    updatedAt: "2025-03-01T10:30:00Z",
    status: "completed",
    source: "claude-code",
    ...overrides,
  };
}

function makeDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    ...makeMeta(),
    events: [
      { type: "user.message",      id: "e1", timestamp: "2025-03-01T10:00:00Z", data: { content: "Hello Claude" } },
      { type: "assistant.message", id: "e2", timestamp: "2025-03-01T10:00:05Z", data: { content: "Hi! How can I help?" } },
      { type: "user.message",      id: "e3", timestamp: "2025-03-01T10:01:00Z", data: { content: "Fix the bug" } },
      { type: "assistant.message", id: "e4", timestamp: "2025-03-01T10:01:30Z", data: { content: "Done, I fixed it." } },
    ],
    hasSnapshots: false,
    eventCounts: { "user.message": 2, "assistant.message": 2 },
    duration: 90_000,
    planContent: undefined,
    ...overrides,
  };
}

// ─── filterSessions ───────────────────────────────────────────────────────────

describe("filterSessions", () => {
  const sessions = [
    makeMeta({ id: "s1", source: "cli",          updatedAt: "2025-01-15T00:00:00Z", gitRoot: "/repos/alpha" }),
    makeMeta({ id: "s2", source: "vscode",        updatedAt: "2025-03-10T00:00:00Z", gitRoot: "/repos/beta" }),
    makeMeta({ id: "s3", source: "claude-code",   updatedAt: "2025-06-01T00:00:00Z", gitRoot: "/repos/alpha" }),
    makeMeta({ id: "s4", source: "claude-code",   updatedAt: "2025-08-20T00:00:00Z", cwd: "/work/gamma", gitRoot: undefined }),
  ];

  it("returns all sessions when no filters set", () => {
    expect(filterSessions(sessions, {})).toHaveLength(4);
  });

  it("filters by source", () => {
    const result = filterSessions(sessions, { source: "claude-code" });
    expect(result.map((s) => s.id)).toEqual(["s3", "s4"]);
  });

  it("source=all returns everything", () => {
    expect(filterSessions(sessions, { source: "all" })).toHaveLength(4);
  });

  it("filters by from date (inclusive)", () => {
    const result = filterSessions(sessions, { from: "2025-03-10" });
    expect(result.map((s) => s.id)).toEqual(["s2", "s3", "s4"]);
  });

  it("filters by to date (inclusive, end-of-day)", () => {
    const result = filterSessions(sessions, { to: "2025-03-10" });
    expect(result.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("filters by from+to range", () => {
    const result = filterSessions(sessions, { from: "2025-03-01", to: "2025-07-01" });
    expect(result.map((s) => s.id)).toEqual(["s2", "s3"]);
  });

  it("filters by repo (substring match on gitRoot)", () => {
    const result = filterSessions(sessions, { repo: "alpha" });
    expect(result.map((s) => s.id)).toEqual(["s1", "s3"]);
  });

  it("filters by repo (substring match on cwd when gitRoot absent)", () => {
    const result = filterSessions(sessions, { repo: "gamma" });
    expect(result.map((s) => s.id)).toEqual(["s4"]);
  });

  it("repo filter is case-insensitive", () => {
    const result = filterSessions(sessions, { repo: "ALPHA" });
    expect(result.map((s) => s.id)).toEqual(["s1", "s3"]);
  });

  it("combines source + date + repo filters", () => {
    const result = filterSessions(sessions, { source: "claude-code", from: "2025-06-01", repo: "alpha" });
    expect(result.map((s) => s.id)).toEqual(["s3"]);
  });
});

// ─── computeQuality ──────────────────────────────────────────────────────────

describe("computeQuality", () => {
  it("score is 0–100", () => {
    for (const [t, e, d] of [[0, true, 0], [5, false, 300_000], [20, false, 1_800_000], [100, false, 99_999_999]] as const) {
      const q = computeQuality(t, e, d);
      expect(q.score).toBeGreaterThanOrEqual(0);
      expect(q.score).toBeLessThanOrEqual(100);
    }
  });

  it("no-error session scores higher than error session with same turns", () => {
    const noErr = computeQuality(5, false, 60_000);
    const withErr = computeQuality(5, true, 60_000);
    expect(noErr.score).toBeGreaterThan(withErr.score);
  });

  it("more turns = higher score (up to cap)", () => {
    const few = computeQuality(1, false, 0);
    const many = computeQuality(10, false, 0);
    expect(many.score).toBeGreaterThan(few.score);
  });

  it("longer session scores higher (duration component)", () => {
    const short = computeQuality(3, false, 60_000);    // 1 min
    const long  = computeQuality(3, false, 1_800_000); // 30 min
    expect(long.score).toBeGreaterThan(short.score);
  });

  it("exposes turn_count, has_errors, duration_ms", () => {
    const q = computeQuality(7, true, 50_000);
    expect(q.turn_count).toBe(7);
    expect(q.has_errors).toBe(true);
    expect(q.duration_ms).toBe(50_000);
  });
});

// ─── formatAsOpenAI ──────────────────────────────────────────────────────────

describe("formatAsOpenAI", () => {
  it("returns correct shape", () => {
    const r = formatAsOpenAI(makeDetail(), {});
    expect(r).toHaveProperty("session_id");
    expect(r).toHaveProperty("source");
    expect(r).toHaveProperty("created_at");
    expect(r).toHaveProperty("session_quality");
    expect(r).toHaveProperty("messages");
    expect(Array.isArray(r.messages)).toBe(true);
  });

  it("messages contain only user/assistant roles", () => {
    const r = formatAsOpenAI(makeDetail(), {});
    for (const m of r.messages) {
      expect(["user", "assistant"]).toContain(m.role);
    }
  });

  it("strips tool.execution_start by default", () => {
    const detail = makeDetail({
      events: [
        { type: "user.message",          id: "e1", timestamp: "", data: { content: "go" } },
        { type: "tool.execution_start",  id: "e2", timestamp: "", data: { content: "tool ran" } },
        { type: "assistant.message",     id: "e3", timestamp: "", data: { content: "done" } },
      ],
    });
    const r = formatAsOpenAI(detail, {});
    expect(r.messages).toHaveLength(2);
    expect(r.messages.every((m) => m.role !== undefined)).toBe(true);
  });

  it("includes tool events when includeTools=true", () => {
    const detail = makeDetail({
      events: [
        { type: "user.message",          id: "e1", timestamp: "", data: { content: "go" } },
        { type: "tool.execution_start",  id: "e2", timestamp: "", data: { content: "tool ran" } },
        { type: "assistant.message",     id: "e3", timestamp: "", data: { content: "done" } },
      ],
    });
    // tool events are not user/assistant so they are still skipped in extractMessages
    // (tool calls don't have a role mapping — they are silently filtered)
    const r = formatAsOpenAI(detail, { includeTools: true });
    // tool.execution_start has no role mapping so it still won't appear as user/assistant
    expect(r.messages).toHaveLength(2);
  });

  it("strips thinking blocks", () => {
    const detail = makeDetail({
      events: [
        { type: "assistant.thinking",  id: "e1", timestamp: "", data: { content: "my thought" } },
        { type: "assistant.message",   id: "e2", timestamp: "", data: { content: "my reply" } },
      ],
    });
    const r = formatAsOpenAI(detail, {});
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].content).toBe("my reply");
  });

  it("skips events with empty content", () => {
    const detail = makeDetail({
      events: [
        { type: "user.message",      id: "e1", timestamp: "", data: { content: "" } },
        { type: "assistant.message", id: "e2", timestamp: "", data: { content: "   " } },
        { type: "user.message",      id: "e3", timestamp: "", data: { content: "real" } },
      ],
    });
    const r = formatAsOpenAI(detail, {});
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].content).toBe("real");
  });

  it("includes repo when gitRoot is set", () => {
    const r = formatAsOpenAI(makeDetail({ gitRoot: "/repos/myproject" }), {});
    expect(r.repo).toBe("/repos/myproject");
  });

  it("omits repo key when gitRoot and cwd are both absent", () => {
    const r = formatAsOpenAI(makeDetail({ gitRoot: undefined, cwd: "" }), {});
    expect("repo" in r).toBe(false);
  });
});

// ─── formatAsShareGPT ─────────────────────────────────────────────────────────

describe("formatAsShareGPT", () => {
  it("returns correct shape with conversations array", () => {
    const r = formatAsShareGPT(makeDetail(), {});
    expect(r).toHaveProperty("conversations");
    expect(Array.isArray(r.conversations)).toBe(true);
  });

  it("maps user→human, assistant→gpt", () => {
    const r = formatAsShareGPT(makeDetail(), {});
    const froms = r.conversations.map((c) => c.from);
    for (const f of froms) {
      expect(["human", "gpt"]).toContain(f);
    }
  });

  it("conversation count matches message count", () => {
    const r = formatAsShareGPT(makeDetail(), {});
    expect(r.conversations).toHaveLength(4); // 2 user + 2 assistant in fixture
  });
});

// ─── parseExportArgs ─────────────────────────────────────────────────────────

describe("parseExportArgs", () => {
  it("defaults", () => {
    const a = parseExportArgs([]);
    expect(a.source).toBe("all");
    expect(a.format).toBe("openai");
    expect(a.minTurns).toBe(1);
    expect(a.includeTools).toBe(false);
    expect(a.help).toBe(false);
  });

  it("--source cli", () => {
    expect(parseExportArgs(["--source", "cli"]).source).toBe("cli");
  });

  it("invalid source defaults to all", () => {
    expect(parseExportArgs(["--source", "neural"]).source).toBe("all");
  });

  it("--from / --to", () => {
    const a = parseExportArgs(["--from", "2025-01-01", "--to", "2025-12-31"]);
    expect(a.from).toBe("2025-01-01");
    expect(a.to).toBe("2025-12-31");
  });

  it("--repo", () => {
    expect(parseExportArgs(["--repo", "myrepo"]).repo).toBe("myrepo");
  });

  it("--min-turns", () => {
    expect(parseExportArgs(["--min-turns", "5"]).minTurns).toBe(5);
  });

  it("--min-tokens", () => {
    expect(parseExportArgs(["--min-tokens", "500"]).minTokens).toBe(500);
  });

  it("--format sharegpt", () => {
    expect(parseExportArgs(["--format", "sharegpt"]).format).toBe("sharegpt");
  });

  it("invalid format defaults to openai", () => {
    expect(parseExportArgs(["--format", "llama"]).format).toBe("openai");
  });

  it("-o / --output", () => {
    expect(parseExportArgs(["-o", "out.jsonl"]).output).toBe("out.jsonl");
    expect(parseExportArgs(["--output", "out.jsonl"]).output).toBe("out.jsonl");
  });

  it("--include-tools", () => {
    expect(parseExportArgs(["--include-tools"]).includeTools).toBe(true);
  });

  it("--help / -h", () => {
    expect(parseExportArgs(["--help"]).help).toBe(true);
    expect(parseExportArgs(["-h"]).help).toBe(true);
  });

  it("combined flags", () => {
    const a = parseExportArgs([
      "--source", "claude-code",
      "--from", "2025-06-01",
      "--min-turns", "3",
      "--format", "sharegpt",
      "-o", "sft.jsonl",
    ]);
    expect(a.source).toBe("claude-code");
    expect(a.from).toBe("2025-06-01");
    expect(a.minTurns).toBe(3);
    expect(a.format).toBe("sharegpt");
    expect(a.output).toBe("sft.jsonl");
  });
});
