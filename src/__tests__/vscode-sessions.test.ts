import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Must mock before importing the module
vi.mock("better-sqlite3", () => {
  return {
    default: vi.fn(),
  };
});

import { _testing, listVSCodeSessions, getVSCodeSession, isVSCodeSession, getVSCodeAnalytics } from "../vscode-sessions";
const { requestsToEvents, deriveStatus, msToIso, readSessionContent } = _testing;

describe("msToIso", () => {
  it("returns empty string for undefined", () => {
    expect(msToIso(undefined)).toBe("");
  });

  it("returns empty string for 0", () => {
    expect(msToIso(0)).toBe("");
  });

  it("converts ms timestamp to ISO string", () => {
    const result = msToIso(1700000000000);
    expect(result).toBe(new Date(1700000000000).toISOString());
  });
});

describe("deriveStatus", () => {
  it("returns completed when timing has endTime", () => {
    expect(
      deriveStatus({
        sessionId: "a",
        title: "",
        lastMessageDate: 0,
        isEmpty: false,
        timing: { startTime: 1000, endTime: 2000 },
      })
    ).toBe("completed");
  });

  it("returns completed when no timing at all", () => {
    expect(
      deriveStatus({
        sessionId: "b",
        title: "",
        lastMessageDate: 0,
        isEmpty: false,
      })
    ).toBe("completed");
  });

  it("returns completed when startTime but no endTime and old", () => {
    expect(
      deriveStatus({
        sessionId: "c",
        title: "",
        lastMessageDate: Date.now() - 1_000_000,
        isEmpty: false,
        timing: { startTime: Date.now() - 1_000_000 },
      })
    ).toBe("completed");
  });

  it("returns running when startTime, no endTime, and recently active", () => {
    expect(
      deriveStatus({
        sessionId: "d",
        title: "",
        lastMessageDate: Date.now() - 1000,
        isEmpty: false,
        timing: { startTime: Date.now() - 60_000 },
      })
    ).toBe("running");
  });
});

describe("requestsToEvents", () => {
  it("returns empty array for empty requests", () => {
    expect(requestsToEvents([])).toEqual([]);
  });

  it("creates user.message and assistant.turn_start for a basic request", () => {
    const events = requestsToEvents([
      {
        requestId: "r1",
        timestamp: 1700000000000,
        message: { text: "Hello" },
        response: [],
      },
    ]);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("user.message");
    expect(events[0].data.content).toBe("Hello");
    expect(events[0].id).toBe("r1");
    expect(events[1].type).toBe("assistant.turn_start");
  });

  it("extracts tool invocations from response parts", () => {
    const events = requestsToEvents([
      {
        requestId: "r2",
        timestamp: 1700000000000,
        message: { text: "Do something" },
        response: [
          {
            kind: "toolInvocationSerialized",
            toolCallId: "tc1",
            originMessage: "bash (Terminal)",
            invocationMessage: { value: "Running bash" },
          },
        ],
      },
    ]);

    const toolStart = events.find((e) => e.type === "tool.execution_start");
    const toolComplete = events.find((e) => e.type === "tool.execution_complete");

    expect(toolStart).toBeDefined();
    expect(toolStart!.data.tool).toBe("bash (Terminal)");
    expect(toolComplete).toBeDefined();
    expect(toolComplete!.data.success).toBe(true);
  });

  it("creates assistant.message from response text parts", () => {
    const events = requestsToEvents([
      {
        requestId: "r3",
        timestamp: 1700000000000,
        message: { text: "Explain this" },
        response: [
          { value: "Here is the explanation", supportThemeIcons: false },
        ],
      },
    ]);

    const assistantMsg = events.find((e) => e.type === "assistant.message");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.data.content).toBe("Here is the explanation");
  });

  it("includes result text in assistant message", () => {
    const events = requestsToEvents([
      {
        requestId: "r4",
        timestamp: 1700000000000,
        message: { text: "Question" },
        response: [],
        result: { value: "Answer from result" },
      },
    ]);

    const assistantMsg = events.find((e) => e.type === "assistant.message");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.data.content).toBe("Answer from result");
  });

  it("skips thinking parts from response text", () => {
    const events = requestsToEvents([
      {
        requestId: "r5",
        timestamp: 1700000000000,
        message: { text: "Think about this" },
        response: [
          { kind: "thinking", value: "internal thought process" },
          { value: "Final answer" },
        ],
      },
    ]);

    const assistantMsg = events.find((e) => e.type === "assistant.message");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.data.content).toBe("Final answer");
    expect(assistantMsg!.data.content).not.toContain("internal thought");
  });

  it("uses modelState.completedAt for response timestamp when available", () => {
    const events = requestsToEvents([
      {
        requestId: "r6",
        timestamp: 1700000000000,
        message: { text: "Q" },
        response: [{ value: "A" }],
        modelState: { completedAt: 1700000005000 },
      },
    ]);

    const assistantMsg = events.find((e) => e.type === "assistant.message");
    expect(assistantMsg!.timestamp).toBe(new Date(1700000005000).toISOString());
  });

  it("skips user message when text is empty", () => {
    const events = requestsToEvents([
      {
        requestId: "r7",
        timestamp: 1700000000000,
        message: { text: "" },
        response: [],
      },
    ]);

    expect(events.filter((e) => e.type === "user.message")).toHaveLength(0);
    // Still has assistant.turn_start
    expect(events.filter((e) => e.type === "assistant.turn_start")).toHaveLength(1);
  });

  it("handles multiple requests in sequence", () => {
    const events = requestsToEvents([
      {
        requestId: "r8",
        timestamp: 1700000000000,
        message: { text: "First" },
        response: [{ value: "Reply 1" }],
      },
      {
        requestId: "r9",
        timestamp: 1700000010000,
        message: { text: "Second" },
        response: [{ value: "Reply 2" }],
      },
    ]);

    const userMsgs = events.filter((e) => e.type === "user.message");
    const assistantMsgs = events.filter((e) => e.type === "assistant.message");

    expect(userMsgs).toHaveLength(2);
    expect(assistantMsgs).toHaveLength(2);
    expect(userMsgs[0].data.content).toBe("First");
    expect(userMsgs[1].data.content).toBe("Second");
    expect(assistantMsgs[0].data.content).toBe("Reply 1");
    expect(assistantMsgs[1].data.content).toBe("Reply 2");
  });
});

describe("readSessionContent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-lens-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads and parses a valid session JSON", () => {
    const session = {
      version: 3,
      sessionId: "test-123",
      requests: [
        { requestId: "r1", message: { text: "Hi" }, response: [] },
      ],
    };
    const filePath = path.join(tmpDir, "test.json");
    fs.writeFileSync(filePath, JSON.stringify(session));

    const result = readSessionContent(filePath);
    expect(result).not.toBeNull();
    expect(result.sessionId).toBe("test-123");
    expect(result.requests).toHaveLength(1);
  });

  it("strips image data from variableData", () => {
    const session = {
      version: 3,
      sessionId: "test-img",
      requests: [
        {
          requestId: "r1",
          message: { text: "Look at this" },
          response: [],
          variableData: {
            variables: [
              {
                kind: "image",
                value: "x".repeat(2000),
                name: "Pasted Image",
                mimeType: "image/png",
              },
            ],
          },
        },
      ],
    };
    const filePath = path.join(tmpDir, "img.json");
    fs.writeFileSync(filePath, JSON.stringify(session));

    const result = readSessionContent(filePath);
    const variable = result.requests[0].variableData.variables[0];
    expect(variable.value).toBe("[image data omitted]");
    expect(variable.kind).toBe("image");
  });

  it("truncates long message text", () => {
    const longText = "a".repeat(20_000);
    const session = {
      version: 3,
      sessionId: "test-long",
      requests: [
        { requestId: "r1", message: { text: longText }, response: [] },
      ],
    };
    const filePath = path.join(tmpDir, "long.json");
    fs.writeFileSync(filePath, JSON.stringify(session));

    const result = readSessionContent(filePath);
    expect(result.requests[0].message.text.length).toBeLessThan(20_000);
    expect(result.requests[0].message.text).toContain("...(truncated)");
  });

  it("truncates long message parts text", () => {
    const longText = "b".repeat(20_000);
    const session = {
      version: 3,
      sessionId: "test-parts",
      requests: [
        {
          requestId: "r1",
          message: { text: "short", parts: [{ text: longText }] },
          response: [],
        },
      ],
    };
    const filePath = path.join(tmpDir, "parts.json");
    fs.writeFileSync(filePath, JSON.stringify(session));

    const result = readSessionContent(filePath);
    expect(result.requests[0].message.parts[0].text).toContain("...(truncated)");
  });

  it("returns null for non-existent file", () => {
    expect(readSessionContent("/nonexistent/file.json")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "not json {{{");

    expect(readSessionContent(filePath)).toBeNull();
  });

  it("preserves small image values", () => {
    const session = {
      version: 3,
      sessionId: "test-small-img",
      requests: [
        {
          requestId: "r1",
          message: { text: "icon" },
          response: [],
          variableData: {
            variables: [
              { kind: "image", value: "tiny", name: "Small Icon" },
            ],
          },
        },
      ],
    };
    const filePath = path.join(tmpDir, "small.json");
    fs.writeFileSync(filePath, JSON.stringify(session));

    const result = readSessionContent(filePath);
    expect(result.requests[0].variableData.variables[0].value).toBe("tiny");
  });
});
