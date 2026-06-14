import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { clearCache } from "../cache";

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("os");
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

vi.mock("../vscode-sessions", () => ({
  listVSCodeSessions: vi.fn(() => []),
  getVSCodeSession: vi.fn(() => null),
  isVSCodeSession: vi.fn(() => false),
  getVSCodeAnalytics: vi.fn(() => []),
  normalizeVSCodeToolName: vi.fn((s: string) => ({ tool: s })),
  scanVSCodeMcpConfig: vi.fn(() => []),
}));

vi.mock("../claude-code-sessions", () => ({
  listClaudeCodeSessions: vi.fn(() => []),
  getClaudeCodeSession: vi.fn(() => null),
  isClaudeCodeSession: vi.fn(() => false),
  getClaudeCodeAnalytics: vi.fn(() => []),
}));

import {
  listSessions,
  getSession,
  getAnalytics,
  getRepoScore,
  listReposWithScores,
} from "../sessions";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSessionDir(
  base: string,
  id: string,
  opts: {
    yaml?: string;
    events?: string[];
    plan?: string;
  } = {}
): string {
  const dir = path.join(base, ".copilot", "session-state", id);
  fs.mkdirSync(dir, { recursive: true });

  const yaml =
    opts.yaml ??
    `id: ${id}
cwd: /home/user/project
git_root: /home/user/project
branch: main
created_at: "2024-01-15T10:00:00Z"
updated_at: "2024-01-15T11:00:00Z"
summary_count: 1
`;
  fs.writeFileSync(path.join(dir, "workspace.yaml"), yaml);

  const events = opts.events ?? [
    JSON.stringify({ type: "session.start", id: "e0", timestamp: "2024-01-15T10:00:00Z", data: { copilotVersion: "0.400" } }),
    JSON.stringify({ type: "user.message", id: "e1", timestamp: "2024-01-15T10:00:05Z", data: { content: "Hello" } }),
    JSON.stringify({ type: "tool.execution_start", id: "e2", timestamp: "2024-01-15T10:00:06Z", data: { tool: "bash" } }),
    JSON.stringify({ type: "tool.execution_complete", id: "e3", timestamp: "2024-01-15T10:00:10Z", data: { tool: "bash", success: true } }),
    JSON.stringify({ type: "assistant.turn_start", id: "e4", timestamp: "2024-01-15T10:00:10Z", data: {} }),
    JSON.stringify({ type: "assistant.message", id: "e5", timestamp: "2024-01-15T10:00:15Z", data: { content: "Done!" } }),
  ];
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.join("\n"));

  if (opts.plan !== undefined) {
    fs.writeFileSync(path.join(dir, "plan.md"), opts.plan);
  }

  return dir;
}

// ── shared setup ─────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-lens-sess-"));
  vi.mocked(os.homedir).mockReturnValue(tmpDir);
  clearCache();
});

afterEach(() => {
  vi.mocked(os.homedir).mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  clearCache();
});

// ── listSessions ─────────────────────────────────────────────────────────────

describe("listSessions", () => {
  it("returns empty array when session dir does not exist", () => {
    expect(listSessions()).toEqual([]);
  });

  it("returns a session parsed from workspace.yaml + events.jsonl", () => {
    makeSessionDir(tmpDir, "session-abc");
    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("session-abc");
    expect(sessions[0].cwd).toBe("/home/user/project");
    expect(sessions[0].branch).toBe("main");
    expect(sessions[0].source).toBe("cli");
  });

  it("skips a session directory that has no workspace.yaml", () => {
    const dir = path.join(tmpDir, ".copilot", "session-state", "no-yaml");
    fs.mkdirSync(dir, { recursive: true });
    expect(listSessions()).toHaveLength(0);
  });

  it("skips a session whose events.jsonl has no user.message", () => {
    makeSessionDir(tmpDir, "session-no-user", {
      events: [
        JSON.stringify({ type: "session.start", id: "e0", timestamp: "2024-01-15T10:00:00Z", data: {} }),
      ],
    });
    expect(listSessions()).toHaveLength(0);
  });

  it("skips a session that has no events.jsonl at all", () => {
    const id = "session-no-events";
    const dir = path.join(tmpDir, ".copilot", "session-state", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "workspace.yaml"), `id: ${id}\ncwd: /tmp\n`);
    expect(listSessions()).toHaveLength(0);
  });

  it("sorts sessions newest-first by createdAt", () => {
    makeSessionDir(tmpDir, "old-session", {
      yaml: `id: old-session\ncwd: /tmp\nbranch: main\ncreated_at: "2024-01-10T10:00:00Z"\nupdated_at: "2024-01-10T11:00:00Z"\n`,
    });
    makeSessionDir(tmpDir, "new-session", {
      yaml: `id: new-session\ncwd: /tmp\nbranch: main\ncreated_at: "2024-01-20T10:00:00Z"\nupdated_at: "2024-01-20T11:00:00Z"\n`,
    });
    const sessions = listSessions();
    expect(sessions[0].id).toBe("new-session");
    expect(sessions[1].id).toBe("old-session");
  });

  it("returns cached result on second call", () => {
    makeSessionDir(tmpDir, "session-cache");
    listSessions();
    // Add another session directory; cached call should not pick it up
    makeSessionDir(tmpDir, "session-extra");
    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
  });
});

// ── getSession ────────────────────────────────────────────────────────────────

describe("getSession", () => {
  it("returns null for a non-existent session", () => {
    expect(getSession("does-not-exist")).toBeNull();
  });

  it("returns session detail with parsed events", () => {
    makeSessionDir(tmpDir, "detail-session");
    const detail = getSession("detail-session");
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe("detail-session");
    expect(detail!.source).toBe("cli");
    expect(detail!.events.length).toBeGreaterThan(0);
  });

  it("extracts copilot version from session.start event", () => {
    makeSessionDir(tmpDir, "version-session");
    const detail = getSession("version-session");
    expect(detail!.copilotVersion).toBe("0.400");
  });

  it("counts events by type", () => {
    makeSessionDir(tmpDir, "count-session");
    const detail = getSession("count-session");
    expect(detail!.eventCounts["session.start"]).toBe(1);
    expect(detail!.eventCounts["user.message"]).toBe(1);
    expect(detail!.eventCounts["tool.execution_start"]).toBe(1);
  });

  it("calculates duration from event timestamps", () => {
    makeSessionDir(tmpDir, "dur-session");
    const detail = getSession("dur-session");
    expect(detail!.duration).toBeGreaterThan(0);
  });

  it("caps individual gaps at 5 minutes in duration calculation", () => {
    makeSessionDir(tmpDir, "gap-session", {
      events: [
        JSON.stringify({ type: "user.message", id: "e1", timestamp: "2024-01-15T10:00:00Z", data: { content: "Hi" } }),
        // 20 minute gap — should be capped at 300_000 ms
        JSON.stringify({ type: "assistant.message", id: "e2", timestamp: "2024-01-15T10:20:00Z", data: { content: "Done" } }),
      ],
    });
    const detail = getSession("gap-session");
    expect(detail!.duration).toBe(300_000);
  });

  it("reads plan.md when present", () => {
    makeSessionDir(tmpDir, "plan-session", { plan: "# My Plan\n- Step 1" });
    const detail = getSession("plan-session");
    expect(detail!.planContent).toContain("My Plan");
  });

  it("returns hasSnapshots false when rewind-snapshots absent", () => {
    makeSessionDir(tmpDir, "snap-session");
    const detail = getSession("snap-session");
    expect(detail!.hasSnapshots).toBe(false);
  });

  it("returns hasSnapshots true when rewind-snapshots/index.json exists", () => {
    const dir = makeSessionDir(tmpDir, "snap-yes-session");
    const snapDir = path.join(dir, "rewind-snapshots");
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, "index.json"), "[]");
    const detail = getSession("snap-yes-session");
    expect(detail!.hasSnapshots).toBe(true);
  });

  it("skips malformed lines in events.jsonl", () => {
    makeSessionDir(tmpDir, "bad-lines-session", {
      events: [
        "not valid json",
        JSON.stringify({ type: "user.message", id: "e1", timestamp: "2024-01-15T10:00:00Z", data: { content: "Hi" } }),
      ],
    });
    const detail = getSession("bad-lines-session");
    expect(detail).not.toBeNull();
    expect(detail!.events).toHaveLength(1);
  });

  it("returns null when workspace.yaml is missing", () => {
    const id = "no-yaml-session";
    const dir = path.join(tmpDir, ".copilot", "session-state", id);
    fs.mkdirSync(dir, { recursive: true });
    expect(getSession(id)).toBeNull();
  });
});

// ── getAnalytics ──────────────────────────────────────────────────────────────

describe("getAnalytics", () => {
  it("returns zero totals when no sessions exist", () => {
    const analytics = getAnalytics();
    expect(analytics.totalSessions).toBe(0);
    expect(analytics.avgDuration).toBe(0);
    expect(analytics.minDuration).toBe(0);
    expect(analytics.maxDuration).toBe(0);
  });

  it("counts sessions per day", () => {
    makeSessionDir(tmpDir, "sess-day1", {
      yaml: `id: sess-day1\ncwd: /tmp\nbranch: main\ncreated_at: "2024-01-15T10:00:00Z"\nupdated_at: "2024-01-15T11:00:00Z"\n`,
    });
    makeSessionDir(tmpDir, "sess-day2", {
      yaml: `id: sess-day2\ncwd: /tmp\nbranch: main\ncreated_at: "2024-01-15T14:00:00Z"\nupdated_at: "2024-01-15T15:00:00Z"\n`,
    });
    const analytics = getAnalytics();
    expect(analytics.totalSessions).toBe(2);
    expect(analytics.sessionsPerDay["2024-01-15"]).toBe(2);
  });

  it("aggregates tool usage from events.jsonl", () => {
    makeSessionDir(tmpDir, "tool-sess", {
      events: [
        JSON.stringify({ type: "user.message", id: "e0", timestamp: "2024-01-15T10:00:00Z", data: { content: "Hi" } }),
        JSON.stringify({ type: "tool.execution_start", id: "e1", timestamp: "2024-01-15T10:00:01Z", data: { tool: "bash" } }),
        JSON.stringify({ type: "tool.execution_start", id: "e2", timestamp: "2024-01-15T10:00:02Z", data: { tool: "bash" } }),
        JSON.stringify({ type: "tool.execution_start", id: "e3", timestamp: "2024-01-15T10:00:03Z", data: { tool: "edit" } }),
      ],
    });
    const analytics = getAnalytics();
    expect(analytics.toolUsage["bash"]).toBe(2);
    expect(analytics.toolUsage["edit"]).toBe(1);
  });

  it("records model usage from session.model_change events", () => {
    makeSessionDir(tmpDir, "model-sess", {
      events: [
        JSON.stringify({ type: "user.message", id: "e0", timestamp: "2024-01-15T10:00:00Z", data: { content: "Hi" } }),
        JSON.stringify({ type: "session.model_change", id: "e1", timestamp: "2024-01-15T10:00:01Z", data: { newModel: "claude-sonnet-4" } }),
      ],
    });
    const analytics = getAnalytics();
    expect(analytics.modelUsage["claude-sonnet-4"]).toBe(1);
  });

  it("records tool success/failure rates", () => {
    makeSessionDir(tmpDir, "rate-sess", {
      events: [
        JSON.stringify({ type: "user.message", id: "e0", timestamp: "2024-01-15T10:00:00Z", data: { content: "Hi" } }),
        JSON.stringify({ type: "tool.execution_complete", id: "e1", timestamp: "2024-01-15T10:00:01Z", data: { tool: "bash", success: true } }),
        JSON.stringify({ type: "tool.execution_complete", id: "e2", timestamp: "2024-01-15T10:00:02Z", data: { tool: "bash", success: false } }),
      ],
    });
    const analytics = getAnalytics();
    expect(analytics.toolSuccessRate["bash"]).toEqual({ success: 1, failure: 1 });
  });

  it("counts turns per session", () => {
    makeSessionDir(tmpDir, "turns-sess", {
      events: [
        JSON.stringify({ type: "user.message", id: "e0", timestamp: "2024-01-15T10:00:00Z", data: { content: "Hi" } }),
        JSON.stringify({ type: "assistant.turn_start", id: "e1", timestamp: "2024-01-15T10:00:01Z", data: {} }),
        JSON.stringify({ type: "assistant.turn_start", id: "e2", timestamp: "2024-01-15T10:00:02Z", data: {} }),
      ],
    });
    const analytics = getAnalytics();
    expect(analytics.turnsPerSession).toContain(2);
  });

  it("records error types", () => {
    makeSessionDir(tmpDir, "err-sess", {
      events: [
        JSON.stringify({ type: "user.message", id: "e0", timestamp: "2024-01-15T10:00:00Z", data: { content: "Hi" } }),
        JSON.stringify({ type: "session.error", id: "e1", timestamp: "2024-01-15T10:00:01Z", data: { errorType: "timeout" } }),
      ],
    });
    const analytics = getAnalytics();
    expect(analytics.errorTypes["timeout"]).toBe(1);
  });

  it("filters by source when source is 'cli'", () => {
    makeSessionDir(tmpDir, "cli-source-sess");
    const analytics = getAnalytics("cli");
    expect(analytics.totalSessions).toBe(1);
  });

  it("returns 0 sessions when filtering by 'vscode' with no VS Code sessions", () => {
    makeSessionDir(tmpDir, "cli-only-sess");
    const analytics = getAnalytics("vscode");
    expect(analytics.totalSessions).toBe(0);
  });

  it("parses MCP server names from session.info events", () => {
    makeSessionDir(tmpDir, "mcp-sess", {
      events: [
        JSON.stringify({ type: "user.message", id: "e0", timestamp: "2024-01-15T10:00:00Z", data: { content: "Hi" } }),
        JSON.stringify({ type: "session.info", id: "e1", timestamp: "2024-01-15T10:00:01Z", data: { infoType: "mcp", message: "Configured MCP servers: github-mcp, local-mcp" } }),
      ],
    });
    const analytics = getAnalytics();
    expect(analytics.mcpServers["github-mcp"]).toBe(1);
    expect(analytics.mcpServers["local-mcp"]).toBe(1);
  });
});

// ── getRepoScore ──────────────────────────────────────────────────────────────

describe("getRepoScore", () => {
  it("returns a score object for a repo with no sessions", () => {
    const score = getRepoScore("/nonexistent/repo");
    expect(score.repo).toBe("/nonexistent/repo");
    expect(score.totalScore).toBeGreaterThanOrEqual(0);
    expect(score.sessionCount).toBe(0);
    expect(score.tips.length).toBeGreaterThan(0);
    expect(score.categories.promptQuality.maxScore).toBe(20);
    expect(score.categories.toolUtilization.maxScore).toBe(20);
    expect(score.categories.efficiency.maxScore).toBe(20);
    expect(score.categories.mcpUtilization.maxScore).toBe(20);
    expect(score.categories.engagement.maxScore).toBe(20);
  });

  it("scores a repo with rich session data", () => {
    const repoPath = "/home/user/project";
    // Create 4 sessions for this repo with diverse tool usage
    for (let i = 0; i < 4; i++) {
      makeSessionDir(tmpDir, `rich-sess-${i}`, {
        yaml: `id: rich-sess-${i}\ncwd: ${repoPath}\ngit_root: ${repoPath}\nbranch: main\ncreated_at: "2024-01-${String(10 + i).padStart(2, "0")}T10:00:00Z"\nupdated_at: "2024-01-${String(10 + i).padStart(2, "0")}T11:00:00Z"\n`,
        events: [
          JSON.stringify({ type: "user.message", id: "e0", timestamp: `2024-01-${String(10 + i).padStart(2, "0")}T10:00:00Z`, data: { content: "A".repeat(120) } }),
          JSON.stringify({ type: "tool.execution_start", id: "e1", timestamp: `2024-01-${String(10 + i).padStart(2, "0")}T10:01:00Z`, data: { tool: `tool${i}` } }),
          JSON.stringify({ type: "tool.execution_complete", id: "e2", timestamp: `2024-01-${String(10 + i).padStart(2, "0")}T10:01:05Z`, data: { tool: `tool${i}`, success: true } }),
          JSON.stringify({ type: "assistant.turn_start", id: "e3", timestamp: `2024-01-${String(10 + i).padStart(2, "0")}T10:02:00Z`, data: {} }),
          JSON.stringify({ type: "assistant.message", id: "e4", timestamp: `2024-01-${String(10 + i).padStart(2, "0")}T10:10:00Z`, data: { content: "Done" } }),
        ],
      });
    }
    clearCache();
    const score = getRepoScore(repoPath);
    expect(score.totalScore).toBeGreaterThan(0);
    expect(score.sessionCount).toBe(4);
  });
});

// ── listReposWithScores ───────────────────────────────────────────────────────

describe("listReposWithScores", () => {
  it("returns empty array when no sessions exist", () => {
    expect(listReposWithScores()).toEqual([]);
  });

  it("excludes repos with fewer than 3 sessions", () => {
    makeSessionDir(tmpDir, "sparse-sess-1", {
      yaml: `id: sparse-sess-1\ncwd: /repo/a\ngit_root: /repo/a\nbranch: main\ncreated_at: "2024-01-10T10:00:00Z"\nupdated_at: "2024-01-10T11:00:00Z"\n`,
    });
    makeSessionDir(tmpDir, "sparse-sess-2", {
      yaml: `id: sparse-sess-2\ncwd: /repo/a\ngit_root: /repo/a\nbranch: main\ncreated_at: "2024-01-11T10:00:00Z"\nupdated_at: "2024-01-11T11:00:00Z"\n`,
    });
    expect(listReposWithScores()).toEqual([]);
  });

  it("includes repos with 3 or more sessions sorted by score desc", () => {
    for (let i = 0; i < 3; i++) {
      makeSessionDir(tmpDir, `qualified-sess-${i}`, {
        yaml: `id: qualified-sess-${i}\ncwd: /repo/b\ngit_root: /repo/b\nbranch: main\ncreated_at: "2024-01-${String(10 + i).padStart(2, "0")}T10:00:00Z"\nupdated_at: "2024-01-${String(10 + i).padStart(2, "0")}T11:00:00Z"\n`,
      });
    }
    clearCache();
    const repos = listReposWithScores();
    expect(repos).toHaveLength(1);
    expect(repos[0].repo).toBe("/repo/b");
  });
});

// ── detectStatus (via getSession) ─────────────────────────────────────────────

describe("detectStatus via getSession", () => {
  it("returns completed when events.jsonl ends with user-initiated abort", () => {
    makeSessionDir(tmpDir, "abort-user-sess", {
      events: [
        JSON.stringify({ type: "user.message", id: "e0", timestamp: "2024-01-15T10:00:00Z", data: { content: "Hi" } }),
        JSON.stringify({ type: "abort", id: "e1", timestamp: "2024-01-15T10:00:01Z", data: { reason: "user initiated" } }),
      ],
    });
    const detail = getSession("abort-user-sess");
    expect(detail!.status).toBe("completed");
  });

  it("returns error when events.jsonl ends with non-user abort", () => {
    makeSessionDir(tmpDir, "abort-err-sess", {
      events: [
        JSON.stringify({ type: "user.message", id: "e0", timestamp: "2024-01-15T10:00:00Z", data: { content: "Hi" } }),
        JSON.stringify({ type: "abort", id: "e1", timestamp: "2024-01-15T10:00:01Z", data: { reason: "crash" } }),
      ],
    });
    const detail = getSession("abort-err-sess");
    expect(detail!.status).toBe("error");
  });
});
