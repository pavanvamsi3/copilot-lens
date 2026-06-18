import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { clearCache } from "../cache";

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("os");
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

vi.mock("better-sqlite3", () => ({ default: vi.fn() }));

import Database from "better-sqlite3";
import {
  listVSCodeSessions,
  getVSCodeSession,
  getVSCodeAnalytics,
  isVSCodeSession,
} from "../vscode-sessions";

// ── helpers ───────────────────────────────────────────────────────────────────

function platformVSCodeDir(home: string): string {
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Code");
  if (process.platform === "win32") return path.join(home, "AppData", "Roaming", "Code");
  return path.join(home, ".config", "Code");
}

function makeVSCodeStructure(home: string): string {
  const codeDir = platformVSCodeDir(home);
  const gsDir = path.join(codeDir, "User", "globalStorage");
  fs.mkdirSync(gsDir, { recursive: true });
  fs.writeFileSync(path.join(gsDir, "state.vscdb"), "");
  return codeDir;
}

function makeSessionFile(codeDir: string, sessionId: string, content: object): void {
  const dir = path.join(codeDir, "User", "globalStorage", "emptyWindowChatSessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(content));
}

function mockDatabase(entries: Record<string, any>): void {
  vi.mocked(Database).mockImplementation(function () {
    return {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({ value: JSON.stringify({ entries }) }),
      }),
      close: vi.fn(),
    };
  } as any);
}

// ── shared setup ──────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-lens-vsc-"));
  vi.mocked(os.homedir).mockReturnValue(tmpDir);
  // Default: empty DB
  mockDatabase({});
  clearCache();
});

afterEach(() => {
  vi.mocked(os.homedir).mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  clearCache();
});

// ── listVSCodeSessions ────────────────────────────────────────────────────────

describe("listVSCodeSessions", () => {
  it("returns empty array when no VS Code data directory exists", () => {
    expect(listVSCodeSessions()).toEqual([]);
  });

  it("returns empty array when index has no entries", () => {
    makeVSCodeStructure(tmpDir);
    expect(listVSCodeSessions()).toEqual([]);
  });

  it("returns a session from the index", () => {
    makeVSCodeStructure(tmpDir);
    mockDatabase({
      "sess-1": {
        sessionId: "sess-1",
        title: "My Session",
        lastMessageDate: 1700000000000,
        timing: { startTime: 1699999000000, endTime: 1700000000000 },
        isEmpty: false,
      },
    });

    const sessions = listVSCodeSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("sess-1");
    expect(sessions[0].source).toBe("vscode");
    expect(sessions[0].title).toBe("My Session");
    expect(sessions[0].status).toBe("completed");
  });

  it("skips sessions marked as empty", () => {
    makeVSCodeStructure(tmpDir);
    mockDatabase({
      "empty-sess": { sessionId: "empty-sess", lastMessageDate: 1700000000000, isEmpty: true },
    });
    expect(listVSCodeSessions()).toHaveLength(0);
  });

  it("skips sessions with no lastMessageDate", () => {
    makeVSCodeStructure(tmpDir);
    mockDatabase({
      "no-date": { sessionId: "no-date", title: "No Date", lastMessageDate: 0, isEmpty: false },
    });
    expect(listVSCodeSessions()).toHaveLength(0);
  });

  it("returns running status for a recently active session", () => {
    makeVSCodeStructure(tmpDir);
    const now = Date.now();
    mockDatabase({
      "running-sess": {
        sessionId: "running-sess",
        title: "Running",
        lastMessageDate: now - 5000,
        timing: { startTime: now - 60000 },
        isEmpty: false,
      },
    });

    const sessions = listVSCodeSessions();
    expect(sessions[0].status).toBe("running");
  });
});

// ── isVSCodeSession ───────────────────────────────────────────────────────────

describe("isVSCodeSession", () => {
  it("returns false when no VS Code dir exists", () => {
    expect(isVSCodeSession("any-id")).toBe(false);
  });

  it("returns false for an ID not in the index", () => {
    makeVSCodeStructure(tmpDir);
    expect(isVSCodeSession("unknown-id")).toBe(false);
  });

  it("returns true for an ID that is in the index", () => {
    makeVSCodeStructure(tmpDir);
    mockDatabase({
      "known-id": { sessionId: "known-id", lastMessageDate: 1700000000000, isEmpty: false },
    });
    expect(isVSCodeSession("known-id")).toBe(true);
  });
});

// ── getVSCodeSession ──────────────────────────────────────────────────────────

describe("getVSCodeSession", () => {
  it("returns null when no VS Code dir exists", () => {
    expect(getVSCodeSession("any-id")).toBeNull();
  });

  it("returns null when session file does not exist", () => {
    makeVSCodeStructure(tmpDir);
    mockDatabase({
      "missing-file": { sessionId: "missing-file", lastMessageDate: 1700000000000, isEmpty: false },
    });
    expect(getVSCodeSession("missing-file")).toBeNull();
  });

  it("returns session detail for a valid session file", () => {
    const codeDir = makeVSCodeStructure(tmpDir);
    const sessionId = "detail-sess";
    mockDatabase({
      [sessionId]: {
        sessionId,
        title: "Detail Session",
        lastMessageDate: 1700000000000,
        timing: { startTime: 1699999000000, endTime: 1700000000000 },
        isEmpty: false,
      },
    });

    makeSessionFile(codeDir, sessionId, {
      sessionId,
      requests: [
        {
          requestId: "r1",
          timestamp: 1700000000000,
          message: { text: "Hello" },
          response: [{ value: "World" }],
        },
      ],
    });

    const detail = getVSCodeSession(sessionId);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(sessionId);
    expect(detail!.source).toBe("vscode");
    expect(detail!.events.some((e) => e.type === "user.message")).toBe(true);
    expect(detail!.events.some((e) => e.type === "assistant.message")).toBe(true);
    expect(detail!.hasSnapshots).toBe(false);
  });

  it("counts events by type across multiple requests", () => {
    const codeDir = makeVSCodeStructure(tmpDir);
    const sessionId = "count-sess";
    mockDatabase({
      [sessionId]: { sessionId, lastMessageDate: 1700000000000, isEmpty: false },
    });

    makeSessionFile(codeDir, sessionId, {
      sessionId,
      requests: [
        { requestId: "r1", timestamp: 1700000000000, message: { text: "Q1" }, response: [{ value: "A1" }] },
        { requestId: "r2", timestamp: 1700000010000, message: { text: "Q2" }, response: [] },
      ],
    });

    const detail = getVSCodeSession(sessionId);
    expect(detail!.eventCounts["user.message"]).toBe(2);
    expect(detail!.eventCounts["assistant.turn_start"]).toBe(2);
  });
});

// ── getVSCodeAnalytics ────────────────────────────────────────────────────────

describe("getVSCodeAnalytics", () => {
  it("returns empty array when no VS Code dir exists", () => {
    expect(getVSCodeAnalytics()).toEqual([]);
  });

  it("skips session entries with no session file", () => {
    makeVSCodeStructure(tmpDir);
    mockDatabase({
      "no-file": { sessionId: "no-file", lastMessageDate: 1700000000000, isEmpty: false },
    });
    expect(getVSCodeAnalytics()).toHaveLength(0);
  });

  it("returns analytics for sessions with session files", () => {
    const codeDir = makeVSCodeStructure(tmpDir);
    const sessionId = "analytics-sess";
    mockDatabase({
      [sessionId]: {
        sessionId,
        title: "Analytics",
        lastMessageDate: 1700000000000,
        timing: { startTime: 1699999000000 },
        isEmpty: false,
      },
    });

    makeSessionFile(codeDir, sessionId, {
      sessionId,
      requests: [
        {
          requestId: "r1",
          timestamp: 1700000000000,
          modelId: "copilot/claude-sonnet-4-6",
          message: { text: "Tell me about X" },
          response: [
            { kind: "toolInvocationSerialized", toolCallId: "tc1", originMessage: "bash (Terminal)" },
            { value: "Here is the answer" },
          ],
        },
      ],
    });

    const analytics = getVSCodeAnalytics();
    expect(analytics).toHaveLength(1);
    expect(analytics[0].sessionId).toBe(sessionId);
    expect(analytics[0].turnCount).toBe(1);
    expect(analytics[0].modelUsage["claude-sonnet-4-6"]).toBe(1);
    expect(analytics[0].toolUsage["bash (Terminal)"]).toBe(1);
    expect(analytics[0].msgLengths[0]).toBe("Tell me about X".length);
  });

  it("calculates duration from request timestamps", () => {
    const codeDir = makeVSCodeStructure(tmpDir);
    const sessionId = "dur-sess";
    mockDatabase({
      [sessionId]: { sessionId, lastMessageDate: 1700000000000, isEmpty: false },
    });

    makeSessionFile(codeDir, sessionId, {
      sessionId,
      requests: [
        { requestId: "r1", timestamp: 1700000000000, message: { text: "Hi" }, response: [] },
        { requestId: "r2", timestamp: 1700000010000, message: { text: "More" }, response: [] },
      ],
    });

    const analytics = getVSCodeAnalytics();
    expect(analytics[0].duration).toBeGreaterThan(0);
  });
});
