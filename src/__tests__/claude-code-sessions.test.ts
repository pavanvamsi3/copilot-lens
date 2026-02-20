import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { _testing, listClaudeCodeSessions, getClaudeCodeSession, isClaudeCodeSession, getClaudeCodeAnalytics } from "../claude-code-sessions";
import { clearCache } from "../cache";
const { extractTextContent, extractToolUseBlocks, deriveStatus, readAllLines } = _testing;

// ============ Unit tests for pure helpers ============

describe("extractTextContent", () => {
  it("returns empty string for undefined", () => {
    expect(extractTextContent(undefined)).toBe("");
  });

  it("returns string as-is", () => {
    expect(extractTextContent("hello world")).toBe("hello world");
  });

  it("joins text blocks from array", () => {
    const blocks = [
      { type: "text", text: "Hello " },
      { type: "thinking", thinking: "thinking..." },
      { type: "text", text: "world" },
    ];
    expect(extractTextContent(blocks)).toBe("Hello world");
  });

  it("skips non-text blocks", () => {
    const blocks = [
      { type: "tool_use", id: "t1", name: "bash", input: {} },
      { type: "text", text: "Done" },
    ];
    expect(extractTextContent(blocks)).toBe("Done");
  });

  it("returns empty string for array with no text blocks", () => {
    const blocks = [{ type: "thinking", thinking: "hmm" }];
    expect(extractTextContent(blocks)).toBe("");
  });
});

describe("extractToolUseBlocks", () => {
  it("returns empty array for undefined", () => {
    expect(extractToolUseBlocks(undefined)).toEqual([]);
  });

  it("returns empty array for string content", () => {
    expect(extractToolUseBlocks("some string")).toEqual([]);
  });

  it("extracts only tool_use blocks", () => {
    const blocks = [
      { type: "thinking", thinking: "hmm" },
      { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
      { type: "text", text: "result" },
      { type: "tool_use", id: "t2", name: "read", input: { path: "/foo" } },
    ];
    const result = extractToolUseBlocks(blocks);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("bash");
    expect(result[1].name).toBe("read");
  });
});

describe("deriveStatus", () => {
  it("returns completed for undefined timestamp", () => {
    expect(deriveStatus(undefined)).toBe("completed");
  });

  it("returns completed for old timestamp", () => {
    const old = new Date(Date.now() - 600_000).toISOString();
    expect(deriveStatus(old)).toBe("completed");
  });

  it("returns running for recent timestamp", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    expect(deriveStatus(recent)).toBe("running");
  });

  it("returns completed for timestamp exactly at 5-min boundary", () => {
    const boundary = new Date(Date.now() - 300_001).toISOString();
    expect(deriveStatus(boundary)).toBe("completed");
  });
});

// ============ Integration tests with temp filesystem ============

function makeEvent(overrides: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2024-01-15T10:00:00Z", ...overrides });
}

describe("listClaudeCodeSessions / getClaudeCodeSession / isClaudeCodeSession", () => {
  let tmpDir: string;
  let projectsDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-lens-test-"));
    projectsDir = path.join(tmpDir, ".claude", "projects");
    projectDir = path.join(projectsDir, "-Users-test-myproject");
    fs.mkdirSync(projectDir, { recursive: true });

    // Override home dir so getClaudeCodeProjectsDir() points to tmpDir
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.HOME;
  });

  function writeSession(sessionId: string, lines: string[]): void {
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      lines.join("\n") + "\n"
    );
  }

  it("returns empty array when projects dir does not exist", () => {
    fs.rmSync(projectsDir, { recursive: true, force: true });
    const sessions = listClaudeCodeSessions();
    expect(sessions).toEqual([]);
  });

  it("skips sessions with no user events", () => {
    writeSession("sess-no-user", [
      makeEvent({ type: "assistant", sessionId: "sess-no-user", cwd: "/foo", gitBranch: "main", slug: "my-slug", message: { model: "claude-sonnet-4-6", content: [{ type: "text", text: "hi" }] } }),
    ]);
    expect(listClaudeCodeSessions()).toHaveLength(0);
  });

  it("skips isSidechain user events when checking for user presence", () => {
    writeSession("sess-sidechain", [
      makeEvent({ type: "user", isSidechain: true, sessionId: "sess-sidechain", cwd: "/foo", gitBranch: "main", slug: "slug", message: { content: "warmup" } }),
    ]);
    expect(listClaudeCodeSessions()).toHaveLength(0);
  });

  it("lists a valid session with correct metadata", () => {
    writeSession("abc-123", [
      makeEvent({ type: "user", isSidechain: false, sessionId: "abc-123", cwd: "/Users/test/myproject", gitBranch: "main", slug: "happy-slug", timestamp: "2024-01-15T10:00:00Z", message: { content: "Hello" } }),
      makeEvent({ type: "assistant", isSidechain: false, sessionId: "abc-123", timestamp: "2024-01-15T10:01:00Z", message: { model: "claude-sonnet-4-6", content: [{ type: "text", text: "Hi there" }] } }),
    ]);

    const sessions = listClaudeCodeSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("abc-123");
    expect(sessions[0].cwd).toBe("/Users/test/myproject");
    expect(sessions[0].branch).toBe("main");
    expect(sessions[0].title).toBe("happy-slug");
    expect(sessions[0].source).toBe("claude-code");
    expect(sessions[0].createdAt).toBe("2024-01-15T10:00:00Z");
    expect(sessions[0].updatedAt).toBe("2024-01-15T10:01:00Z");
  });

  it("skips files inside subagents subdirectory", () => {
    const subagentsDir = path.join(projectDir, "subagents");
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentsDir, "agent-abc.jsonl"),
      makeEvent({ type: "user", sessionId: "agent-abc", cwd: "/foo", slug: "s", message: { content: "hi" } }) + "\n"
    );
    // subagentsDir is a subdir of projectDir, not a .jsonl at top level — should be ignored
    expect(listClaudeCodeSessions()).toHaveLength(0);
  });

  it("isClaudeCodeSession returns true for existing session", () => {
    writeSession("my-session-id", [
      makeEvent({ type: "user", sessionId: "my-session-id", cwd: "/foo", slug: "s", message: { content: "hi" } }),
    ]);
    expect(isClaudeCodeSession("my-session-id")).toBe(true);
  });

  it("isClaudeCodeSession returns false for unknown id", () => {
    expect(isClaudeCodeSession("does-not-exist")).toBe(false);
  });

  it("getClaudeCodeSession returns null for unknown session", () => {
    expect(getClaudeCodeSession("does-not-exist")).toBeNull();
  });

  it("getClaudeCodeSession converts user events to user.message", () => {
    writeSession("sess-1", [
      makeEvent({ type: "user", isSidechain: false, sessionId: "sess-1", cwd: "/proj", gitBranch: "main", slug: "test-slug", timestamp: "2024-01-15T10:00:00Z", message: { content: "What is 2+2?" } }),
    ]);

    const detail = getClaudeCodeSession("sess-1");
    expect(detail).not.toBeNull();
    const userEvents = detail!.events.filter((e) => e.type === "user.message");
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0].data.content).toBe("What is 2+2?");
    expect(detail!.source).toBe("claude-code");
    expect(detail!.title).toBe("test-slug");
  });

  it("getClaudeCodeSession converts assistant text to assistant.message", () => {
    writeSession("sess-2", [
      makeEvent({ type: "user", isSidechain: false, sessionId: "sess-2", cwd: "/proj", slug: "s", timestamp: "2024-01-15T10:00:00Z", message: { content: "Hello" } }),
      makeEvent({ type: "assistant", isSidechain: false, sessionId: "sess-2", timestamp: "2024-01-15T10:00:05Z", message: { model: "claude-sonnet-4-6", content: [{ type: "thinking", thinking: "let me think" }, { type: "text", text: "World" }] } }),
    ]);

    const detail = getClaudeCodeSession("sess-2");
    const assistantEvents = detail!.events.filter((e) => e.type === "assistant.message");
    expect(assistantEvents).toHaveLength(1);
    expect(assistantEvents[0].data.content).toBe("World");
    expect(assistantEvents[0].data.model).toBe("claude-sonnet-4-6");
  });

  it("getClaudeCodeSession emits tool.execution_start for each tool_use block", () => {
    writeSession("sess-3", [
      makeEvent({ type: "user", isSidechain: false, sessionId: "sess-3", cwd: "/proj", slug: "s", timestamp: "2024-01-15T10:00:00Z", message: { content: "run something" } }),
      makeEvent({ type: "assistant", isSidechain: false, sessionId: "sess-3", timestamp: "2024-01-15T10:00:05Z", message: { model: "claude-sonnet-4-6", content: [
        { type: "tool_use", id: "tool-1", name: "bash", input: { cmd: "ls" } },
        { type: "tool_use", id: "tool-2", name: "read", input: { path: "/foo" } },
        { type: "text", text: "Done" },
      ] } }),
    ]);

    const detail = getClaudeCodeSession("sess-3");
    const toolEvents = detail!.events.filter((e) => e.type === "tool.execution_start");
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0].data.tool).toBe("bash");
    expect(toolEvents[1].data.tool).toBe("read");
  });

  it("getClaudeCodeSession skips isSidechain events", () => {
    writeSession("sess-4", [
      makeEvent({ type: "user", isSidechain: false, sessionId: "sess-4", cwd: "/proj", slug: "s", timestamp: "2024-01-15T10:00:00Z", message: { content: "real message" } }),
      makeEvent({ type: "user", isSidechain: true, sessionId: "sess-4", timestamp: "2024-01-15T10:00:01Z", message: { content: "warmup noise" } }),
    ]);

    const detail = getClaudeCodeSession("sess-4");
    const userEvents = detail!.events.filter((e) => e.type === "user.message");
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0].data.content).toBe("real message");
  });

  it("getClaudeCodeSession computes gap-capped duration", () => {
    writeSession("sess-5", [
      makeEvent({ type: "user", isSidechain: false, sessionId: "sess-5", cwd: "/proj", slug: "s", timestamp: "2024-01-15T10:00:00Z", message: { content: "start" } }),
      makeEvent({ type: "assistant", isSidechain: false, sessionId: "sess-5", timestamp: "2024-01-15T10:01:00Z", message: { model: "m", content: [{ type: "text", text: "ok" }] } }),
      // 2-hour gap — should be capped at 5 min
      makeEvent({ type: "user", isSidechain: false, sessionId: "sess-5", timestamp: "2024-01-15T12:01:00Z", message: { content: "later" } }),
    ]);

    const detail = getClaudeCodeSession("sess-5");
    // 1 min gap + capped 5 min gap = 6 min = 360_000ms
    expect(detail!.duration).toBe(360_000);
  });
});

// ============ Analytics ============

describe("getClaudeCodeAnalytics", () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-lens-analytics-"));
    projectDir = path.join(tmpDir, ".claude", "projects", "-Users-test-proj");
    fs.mkdirSync(projectDir, { recursive: true });
    process.env.HOME = tmpDir;
    clearCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.HOME;
    clearCache();
  });

  function writeSession(sessionId: string, lines: string[]): void {
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      lines.join("\n") + "\n"
    );
  }

  it("returns empty array when no sessions", () => {
    expect(getClaudeCodeAnalytics()).toEqual([]);
  });

  it("aggregates tool and model usage per session", () => {
    writeSession("a1", [
      makeEvent({ type: "user", isSidechain: false, sessionId: "a1", cwd: "/x", slug: "test-slug", timestamp: "2024-01-15T10:00:00Z", message: { content: "go" } }),
      makeEvent({ type: "assistant", isSidechain: false, sessionId: "a1", timestamp: "2024-01-15T10:00:05Z", message: { model: "claude-sonnet-4-6", content: [
        { type: "tool_use", id: "t1", name: "bash", input: {} },
        { type: "tool_use", id: "t2", name: "bash", input: {} },
        { type: "tool_use", id: "t3", name: "read", input: {} },
        { type: "text", text: "done" },
      ] } }),
    ]);

    const entries = getClaudeCodeAnalytics();
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe("a1");
    expect(entries[0].title).toBe("test-slug");
    expect(entries[0].toolUsage).toEqual({ bash: 2, read: 1 });
    expect(entries[0].modelUsage).toEqual({ "claude-sonnet-4-6": 1 });
    expect(entries[0].turnCount).toBe(1);
    expect(entries[0].msgLengths).toEqual([2]); // "go".length
  });
});
