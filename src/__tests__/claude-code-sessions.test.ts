import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  _testing,
  normalizeClaudeCodeToolName,
  claudeCodeEntriesToEvents,
  parseClaudeCodeJsonl,
  listClaudeCodeSessions,
  getClaudeCodeSession,
  isClaudeCodeSession,
  scanClaudeCodeMcpConfig,
  decodeProjectPath,
  type ClaudeCodeEntry,
} from "../claude-code-sessions";
import { clearCache } from "../cache";

const { detectClaudeCodeStatus, _scanClaudeCodeSessions } = _testing;

// ============ decodeProjectPath ============

describe("decodeProjectPath", () => {
  it("decodes Unix-style project path", () => {
    expect(decodeProjectPath("-home-user-myproject")).toBe("/home/user/myproject");
  });

  it("decodes a simple path without dashes in dir names", () => {
    expect(decodeProjectPath("-home-user-projects")).toBe("/home/user/projects");
  });

  it("returns empty string for empty input", () => {
    expect(decodeProjectPath("")).toBe("");
  });
});

// ============ normalizeClaudeCodeToolName ============

describe("normalizeClaudeCodeToolName", () => {
  it("normalizes Edit → edit_file", () => expect(normalizeClaudeCodeToolName("Edit")).toBe("edit_file"));
  it("normalizes MultiEdit → edit_file", () => expect(normalizeClaudeCodeToolName("MultiEdit")).toBe("edit_file"));
  it("normalizes Read → read_file", () => expect(normalizeClaudeCodeToolName("Read")).toBe("read_file"));
  it("normalizes Write → write_file", () => expect(normalizeClaudeCodeToolName("Write")).toBe("write_file"));
  it("normalizes Bash → bash", () => expect(normalizeClaudeCodeToolName("Bash")).toBe("bash"));
  it("normalizes Search → search", () => expect(normalizeClaudeCodeToolName("Search")).toBe("search"));
  it("normalizes Glob → glob", () => expect(normalizeClaudeCodeToolName("Glob")).toBe("glob"));
  it("normalizes Grep → grep", () => expect(normalizeClaudeCodeToolName("Grep")).toBe("grep"));
  it("normalizes WebSearch → web_search", () => expect(normalizeClaudeCodeToolName("WebSearch")).toBe("web_search"));
  it("normalizes WebFetch → web_fetch", () => expect(normalizeClaudeCodeToolName("WebFetch")).toBe("web_fetch"));
  it("normalizes TodoRead → todo", () => expect(normalizeClaudeCodeToolName("TodoRead")).toBe("todo"));
  it("normalizes TodoWrite → todo", () => expect(normalizeClaudeCodeToolName("TodoWrite")).toBe("todo"));

  it("normalizes MCP tool names (mcp__ prefix)", () => {
    expect(normalizeClaudeCodeToolName("mcp__github__list_repos")).toBe("github.list_repos");
  });

  it("normalizes MCP tool with two underscores after server", () => {
    expect(normalizeClaudeCodeToolName("mcp__my_server__do_thing")).toBe("my_server.do_thing");
  });

  it("passes through unknown tool names unchanged", () => {
    expect(normalizeClaudeCodeToolName("CustomTool")).toBe("CustomTool");
  });
});

// ============ claudeCodeEntriesToEvents ============

describe("claudeCodeEntriesToEvents", () => {
  it("returns empty array for empty entries", () => {
    expect(claudeCodeEntriesToEvents([])).toEqual([]);
  });

  it("skips summary and file-history-snapshot entries", () => {
    const entries: ClaudeCodeEntry[] = [
      { type: "summary", summary: "My session", leafUuid: "abc" },
      { type: "file-history-snapshot", uuid: "snap1", timestamp: "2025-01-01T10:00:00Z" },
    ];
    expect(claudeCodeEntriesToEvents(entries)).toEqual([]);
  });

  it("converts user string message to user.message event", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2025-01-01T10:00:00Z",
        message: { role: "user", content: "How do I mock HTTP requests?" },
      },
    ];
    const events = claudeCodeEntriesToEvents(entries);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user.message");
    expect(events[0].data.content).toBe("How do I mock HTTP requests?");
    expect(events[0].id).toBe("u1");
    expect(events[0].timestamp).toBe("2025-01-01T10:00:00Z");
  });

  it("skips user message with empty string content", () => {
    const entries: ClaudeCodeEntry[] = [
      { type: "user", uuid: "u2", timestamp: "2025-01-01T10:00:00Z", message: { content: "  " } },
    ];
    expect(claudeCodeEntriesToEvents(entries)).toEqual([]);
  });

  it("converts tool_result content blocks to tool.execution_complete events", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        type: "user",
        uuid: "u3",
        timestamp: "2025-01-01T10:00:00Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-1", content: "File created successfully" },
          ],
        },
      },
    ];
    const events = claudeCodeEntriesToEvents(entries);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.execution_complete");
    expect(events[0].id).toBe("call-1");
    expect(events[0].data.result).toBe("File created successfully");
  });

  it("converts assistant text block to assistant.message event", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2025-01-01T10:00:05Z",
        model: "claude-sonnet-4-20250514",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "You can use jest.mock..." }],
        },
      },
    ];
    const events = claudeCodeEntriesToEvents(entries);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant.message");
    expect(events[0].data.content).toBe("You can use jest.mock...");
    expect(events[0].data.model).toBe("claude-sonnet-4-20250514");
  });

  it("converts tool_use block to tool.execution_start event", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        type: "assistant",
        uuid: "a2",
        timestamp: "2025-01-01T10:00:05Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-2",
              name: "Edit",
              input: { file_path: "/src/app.ts" },
            },
          ],
        },
      },
    ];
    const events = claudeCodeEntriesToEvents(entries);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.execution_start");
    expect(events[0].id).toBe("call-2");
    expect(events[0].data.tool).toBe("edit_file");
    expect(events[0].data.rawName).toBe("Edit");
  });

  it("converts mixed assistant content (text + tool_use) to multiple events", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        type: "assistant",
        uuid: "a3",
        timestamp: "2025-01-01T10:00:05Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me fix that file." },
            { type: "tool_use", id: "call-3", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
    ];
    const events = claudeCodeEntriesToEvents(entries);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("assistant.message");
    expect(events[1].type).toBe("tool.execution_start");
  });

  it("filters out sidechain entries", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        type: "user",
        uuid: "u4",
        timestamp: "2025-01-01T10:00:00Z",
        isSidechain: true,
        message: { content: "Sidechain message" },
      },
      {
        type: "user",
        uuid: "u5",
        timestamp: "2025-01-01T10:00:01Z",
        message: { content: "Main message" },
      },
    ];
    const events = claudeCodeEntriesToEvents(entries);
    expect(events).toHaveLength(1);
    expect(events[0].data.content).toBe("Main message");
  });

  it("filters out compact summary entries", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        type: "assistant",
        uuid: "a4",
        timestamp: "2025-01-01T10:00:05Z",
        isCompactSummary: true,
        message: { content: [{ type: "text", text: "Compact summary content" }] },
      },
    ];
    expect(claudeCodeEntriesToEvents(entries)).toEqual([]);
  });

  it("includes costUSD in assistant.message data", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        type: "assistant",
        uuid: "a5",
        timestamp: "2025-01-01T10:00:05Z",
        costUSD: 0.003,
        message: { content: [{ type: "text", text: "Here is my response." }] },
      },
    ];
    const events = claudeCodeEntriesToEvents(entries);
    expect(events[0].data.costUSD).toBe(0.003);
  });
});

// ============ parseClaudeCodeJsonl ============

describe("parseClaudeCodeJsonl", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-lens-claude-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses a valid JSONL file", () => {
    const filePath = path.join(tmpDir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "summary", summary: "Test session" }),
      JSON.stringify({ type: "user", uuid: "u1", timestamp: "2025-01-01T10:00:00Z", message: { content: "Hello" } }),
    ];
    fs.writeFileSync(filePath, lines.join("\n"));

    const result = parseClaudeCodeJsonl(filePath);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("summary");
    expect(result[1].type).toBe("user");
  });

  it("skips malformed lines", () => {
    const filePath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "summary", summary: "Test" }),
        "not json {{{",
        JSON.stringify({ type: "user", uuid: "u1", timestamp: "2025-01-01T10:00:00Z", message: { content: "Hi" } }),
      ].join("\n")
    );

    const result = parseClaudeCodeJsonl(filePath);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for non-existent file", () => {
    expect(parseClaudeCodeJsonl("/nonexistent/file.jsonl")).toEqual([]);
  });

  it("returns empty array for empty file", () => {
    const filePath = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(filePath, "");
    expect(parseClaudeCodeJsonl(filePath)).toEqual([]);
  });

  it("handles files with blank lines", () => {
    const filePath = path.join(tmpDir, "blanks.jsonl");
    fs.writeFileSync(
      filePath,
      "\n" + JSON.stringify({ type: "summary", summary: "Test" }) + "\n\n"
    );
    const result = parseClaudeCodeJsonl(filePath);
    expect(result).toHaveLength(1);
  });
});

// ============ listClaudeCodeSessions / getClaudeCodeSession ============

describe("listClaudeCodeSessions and getClaudeCodeSession", () => {
  let tmpDir: string;
  let origHome: string;

  beforeEach(() => {
    clearCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-lens-claude-dir-"));
    origHome = process.env.HOME || "";
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.HOME = origHome;
    clearCache();
  });

  function createSessionFixture(
    projectDirName: string,
    sessionId: string,
    entries: ClaudeCodeEntry[]
  ): string {
    const projectDir = path.join(tmpDir, ".claude", "projects", projectDirName);
    fs.mkdirSync(projectDir, { recursive: true });
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n"));
    return filePath;
  }

  it("returns empty array when ~/.claude/projects does not exist", () => {
    const sessions = listClaudeCodeSessions();
    expect(sessions).toEqual([]);
  });

  it("lists sessions from a project directory", () => {
    createSessionFixture("-home-user-myproject", "test-session-uuid", [
      { type: "summary", summary: "My Test Session" },
      {
        type: "user",
        uuid: "u1",
        sessionId: "test-session-uuid",
        timestamp: "2025-01-01T10:00:00.000Z",
        message: { role: "user", content: "Hello Claude!" },
      },
      {
        type: "assistant",
        uuid: "a1",
        sessionId: "test-session-uuid",
        timestamp: "2025-01-01T10:00:05.000Z",
        model: "claude-sonnet-4-20250514",
        message: { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
      },
    ]);

    const sessions = listClaudeCodeSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const session = sessions.find((s) => s.id === "test-session-uuid");
    expect(session).toBeDefined();
    expect(session!.source).toBe("claude-code");
    expect(session!.title).toBe("My Test Session");
    expect(session!.createdAt).toBe("2025-01-01T10:00:00.000Z");
  });

  it("uses first user message as title when no summary", () => {
    createSessionFixture("-home-user-other", "no-summary-uuid", [
      {
        type: "user",
        uuid: "u1",
        sessionId: "no-summary-uuid",
        timestamp: "2025-01-01T09:00:00.000Z",
        message: { role: "user", content: "What is the capital of France?" },
      },
    ]);

    const sessions = listClaudeCodeSessions();
    const session = sessions.find((s) => s.id === "no-summary-uuid");
    expect(session).toBeDefined();
    expect(session!.title).toBe("What is the capital of France?");
  });

  it("skips sessions with no user messages", () => {
    createSessionFixture("-home-user-empty", "empty-session-uuid", [
      { type: "summary", summary: "Empty" },
    ]);

    const sessions = listClaudeCodeSessions();
    const session = sessions.find((s) => s.id === "empty-session-uuid");
    expect(session).toBeUndefined();
  });

  it("getClaudeCodeSession returns full session detail", () => {
    createSessionFixture("-home-user-proj", "full-session-uuid", [
      { type: "summary", summary: "Full Session" },
      {
        type: "user",
        uuid: "u1",
        sessionId: "full-session-uuid",
        timestamp: "2025-01-01T10:00:00.000Z",
        message: { content: "Help me refactor this" },
      },
      {
        type: "assistant",
        uuid: "a1",
        sessionId: "full-session-uuid",
        timestamp: "2025-01-01T10:00:05.000Z",
        model: "claude-sonnet-4-20250514",
        costUSD: 0.002,
        message: {
          content: [
            { type: "text", text: "Sure, let me look at your code." },
            { type: "tool_use", id: "tc1", name: "Read", input: { file_path: "src/app.ts" } },
          ],
        },
      },
    ]);

    const session = getClaudeCodeSession("full-session-uuid");
    expect(session).not.toBeNull();
    expect(session!.source).toBe("claude-code");
    expect(session!.title).toBe("Full Session");
    expect(session!.events.some((e) => e.type === "user.message")).toBe(true);
    expect(session!.events.some((e) => e.type === "assistant.message")).toBe(true);
    expect(session!.events.some((e) => e.type === "tool.execution_start")).toBe(true);
    expect(session!.hasSnapshots).toBe(false);
    expect(session!.planContent).toBeUndefined();
    expect(session!.eventCounts["user.message"]).toBe(1);
    expect(session!.eventCounts["tool.execution_start"]).toBe(1);
  });

  it("getClaudeCodeSession returns null for unknown session", () => {
    // Create the projects dir so it exists
    fs.mkdirSync(path.join(tmpDir, ".claude", "projects"), { recursive: true });
    expect(getClaudeCodeSession("nonexistent-session-id")).toBeNull();
  });
});

// ============ isClaudeCodeSession ============

describe("isClaudeCodeSession", () => {
  let tmpDir: string;
  let origHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-lens-claude-is-"));
    origHome = process.env.HOME || "";
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.HOME = origHome;
  });

  it("returns false when ~/.claude/projects does not exist", () => {
    expect(isClaudeCodeSession("any-id")).toBe(false);
  });

  it("returns true when JSONL file exists for session", () => {
    const projectDir = path.join(tmpDir, ".claude", "projects", "-home-user-proj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "found-session.jsonl"), "");
    expect(isClaudeCodeSession("found-session")).toBe(true);
  });

  it("returns false when session does not exist", () => {
    const projectDir = path.join(tmpDir, ".claude", "projects", "-home-user-proj");
    fs.mkdirSync(projectDir, { recursive: true });
    expect(isClaudeCodeSession("not-there")).toBe(false);
  });
});

// ============ scanClaudeCodeMcpConfig ============

describe("scanClaudeCodeMcpConfig", () => {
  let tmpDir: string;
  let origHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-lens-claude-mcp-"));
    origHome = process.env.HOME || "";
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.HOME = origHome;
  });

  it("returns empty array when no config exists", () => {
    expect(scanClaudeCodeMcpConfig()).toEqual([]);
  });

  it("reads mcpServers from ~/.claude/settings.json", () => {
    const claudeDir = path.join(tmpDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({
        mcpServers: {
          "github-mcp-server": { command: "npx", args: ["github-mcp"] },
          "bluebird-mcp": { command: "node", args: ["bluebird.js"] },
        },
      })
    );

    const result = scanClaudeCodeMcpConfig();
    expect(result).toEqual(["github-mcp-server", "bluebird-mcp"]);
  });

  it("strips trailing commas (JSONC format)", () => {
    const claudeDir = path.join(tmpDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const jsonc = `{
      "mcpServers": {
        "my-server": { "command": "node", },
      },
    }`;
    fs.writeFileSync(path.join(claudeDir, "settings.json"), jsonc);

    const result = scanClaudeCodeMcpConfig();
    expect(result).toEqual(["my-server"]);
  });

  it("supports mcp_servers key as fallback", () => {
    const claudeDir = path.join(tmpDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ mcp_servers: { "server-a": {} } })
    );

    const result = scanClaudeCodeMcpConfig();
    expect(result).toEqual(["server-a"]);
  });
});

// ============ detectClaudeCodeStatus ============

describe("detectClaudeCodeStatus", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-lens-claude-status-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns completed for a file modified long ago", () => {
    const filePath = path.join(tmpDir, "old.jsonl");
    fs.writeFileSync(filePath, "");
    // Set mtime to 10 minutes ago
    const oldTime = new Date(Date.now() - 600_000);
    fs.utimesSync(filePath, oldTime, oldTime);

    expect(detectClaudeCodeStatus(filePath)).toBe("completed");
  });

  it("returns running for a recently modified file", () => {
    const filePath = path.join(tmpDir, "fresh.jsonl");
    fs.writeFileSync(filePath, "");
    // mtime is now — well within 5 min window

    expect(detectClaudeCodeStatus(filePath)).toBe("running");
  });

  it("returns completed for non-existent file", () => {
    expect(detectClaudeCodeStatus("/nonexistent/file.jsonl")).toBe("completed");
  });
});

// ============ Source field ============

describe("source field", () => {
  it("claude-code is a valid SessionSource value", () => {
    const source: import("../sessions").SessionSource = "claude-code";
    expect(source).toBe("claude-code");
  });
});
