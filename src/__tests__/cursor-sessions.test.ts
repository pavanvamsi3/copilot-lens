import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

vi.mock("better-sqlite3", () => {
  return {
    default: vi.fn(),
  };
});

import { _testing } from "../cursor-sessions";
const { tabToEvents, tabHasContent, deriveStatus, msToIso, CHAT_KEYS } = _testing;

// ============ msToIso ============

describe("msToIso", () => {
  it("returns empty string for undefined", () => {
    expect(msToIso(undefined)).toBe("");
  });

  it("returns empty string for 0", () => {
    expect(msToIso(0)).toBe("");
  });

  it("converts a valid ms timestamp to ISO string", () => {
    const result = msToIso(1700000000000);
    expect(result).toBe(new Date(1700000000000).toISOString());
  });
});

// ============ deriveStatus ============

describe("deriveStatus", () => {
  it("returns completed when lastSendTime is undefined", () => {
    expect(deriveStatus(undefined)).toBe("completed");
  });

  it("returns completed when lastSendTime is old", () => {
    expect(deriveStatus(Date.now() - 2_000_000)).toBe("completed");
  });

  it("returns running when lastSendTime is recent", () => {
    expect(deriveStatus(Date.now() - 1000)).toBe("running");
  });
});

// ============ tabHasContent ============

describe("tabHasContent", () => {
  it("returns false for a tab with no bubbles", () => {
    expect(tabHasContent({ tabId: "t1" })).toBe(false);
  });

  it("returns false for a tab with only empty user bubbles", () => {
    expect(
      tabHasContent({
        tabId: "t2",
        bubbles: [{ type: "user", text: "   " }],
      })
    ).toBe(false);
  });

  it("returns false for a tab with only AI bubbles", () => {
    expect(
      tabHasContent({
        tabId: "t3",
        bubbles: [{ type: "ai", text: "Hello" }],
      })
    ).toBe(false);
  });

  it("returns true when there is at least one non-empty user bubble", () => {
    expect(
      tabHasContent({
        tabId: "t4",
        bubbles: [{ type: "user", text: "What is 2+2?" }],
      })
    ).toBe(true);
  });

  it("uses richText as fallback when text is absent", () => {
    expect(
      tabHasContent({
        tabId: "t5",
        bubbles: [{ type: "user", richText: "a question" }],
      })
    ).toBe(true);
  });
});

// ============ tabToEvents ============

describe("tabToEvents", () => {
  it("returns empty array for a tab with no bubbles", () => {
    expect(tabToEvents({ tabId: "t1" })).toEqual([]);
  });

  it("skips empty user bubbles", () => {
    const events = tabToEvents({
      tabId: "t2",
      bubbles: [{ type: "user", text: "" }],
    });
    expect(events).toHaveLength(0);
  });

  it("creates a user.message event for a user bubble with text", () => {
    const events = tabToEvents({
      tabId: "t3",
      bubbles: [
        {
          type: "user",
          text: "Hello world",
          timingInfo: { clientStartTime: 1700000000000 },
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user.message");
    expect(events[0].data.content).toBe("Hello world");
    expect(events[0].timestamp).toBe(new Date(1700000000000).toISOString());
  });

  it("uses richText when text is absent", () => {
    const events = tabToEvents({
      tabId: "t4",
      bubbles: [{ type: "user", richText: "rich question" }],
    });
    expect(events[0].data.content).toBe("rich question");
  });

  it("creates an assistant.message event for an AI bubble", () => {
    const events = tabToEvents({
      tabId: "t5",
      bubbles: [
        {
          type: "ai",
          text: "Here is the answer",
          modelType: "claude-sonnet-4-5",
          timingInfo: {
            clientStartTime: 1700000000000,
            clientEndTime: 1700000005000,
          },
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant.message");
    expect(events[0].data.content).toBe("Here is the answer");
    expect(events[0].data.model).toBe("claude-sonnet-4-5");
    // Should use clientEndTime for response timestamp
    expect(events[0].timestamp).toBe(new Date(1700000005000).toISOString());
  });

  it("skips AI bubbles with no text", () => {
    const events = tabToEvents({
      tabId: "t6",
      bubbles: [{ type: "ai", text: "" }],
    });
    expect(events).toHaveLength(0);
  });

  it("handles a full user+ai conversation turn", () => {
    const events = tabToEvents({
      tabId: "t7",
      bubbles: [
        {
          type: "user",
          text: "Explain closures",
          timingInfo: { clientStartTime: 1700000000000 },
        },
        {
          type: "ai",
          text: "A closure is a function that captures its lexical scope.",
          modelType: "gpt-4o",
          timingInfo: { clientStartTime: 1700000001000, clientEndTime: 1700000003000 },
        },
      ],
    });
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("user.message");
    expect(events[1].type).toBe("assistant.message");
    expect(events[1].data.model).toBe("gpt-4o");
  });

  it("handles multiple conversation turns", () => {
    const events = tabToEvents({
      tabId: "t8",
      bubbles: [
        { type: "user", text: "First question" },
        { type: "ai", text: "First answer" },
        { type: "user", text: "Second question" },
        { type: "ai", text: "Second answer" },
      ],
    });
    const userMsgs = events.filter((e) => e.type === "user.message");
    const aiMsgs = events.filter((e) => e.type === "assistant.message");
    expect(userMsgs).toHaveLength(2);
    expect(aiMsgs).toHaveLength(2);
  });

  it("falls back to firstTokenTime when clientEndTime is absent", () => {
    const events = tabToEvents({
      tabId: "t9",
      bubbles: [
        {
          type: "ai",
          text: "Answer",
          timingInfo: { clientStartTime: 1700000000000, firstTokenTime: 1700000001000 },
        },
      ],
    });
    expect(events[0].timestamp).toBe(new Date(1700000001000).toISOString());
  });

  it("falls back to clientStartTime when no end or firstToken time", () => {
    const events = tabToEvents({
      tabId: "t10",
      bubbles: [
        {
          type: "ai",
          text: "Answer",
          timingInfo: { clientStartTime: 1700000000000 },
        },
      ],
    });
    expect(events[0].timestamp).toBe(new Date(1700000000000).toISOString());
  });
});

// ============ CHAT_KEYS ============

describe("CHAT_KEYS", () => {
  it("includes the primary Cursor chat key", () => {
    expect(CHAT_KEYS).toContain("workbench.panel.aichat.view.aichat.chatdata");
  });

  it("contains at least 2 fallback keys", () => {
    expect(CHAT_KEYS.length).toBeGreaterThanOrEqual(2);
  });
});

// ============ getCursorDataDirs path resolution ============

describe("getCursorDataDirs", () => {
  let tmpDir: string;
  let origHome: string;
  let origAppData: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-lens-cursor-test-"));
    origHome = process.env.HOME || "";
    origAppData = process.env.APPDATA;
    process.env.HOME = tmpDir;
    if (process.platform === "win32") {
      process.env.APPDATA = path.join(tmpDir, "AppData", "Roaming");
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.HOME = origHome;
    if (origAppData !== undefined) {
      process.env.APPDATA = origAppData;
    } else {
      delete process.env.APPDATA;
    }
  });

  it("returns empty array when no Cursor directory exists", () => {
    const { getCursorDataDirs } = _testing;
    expect(getCursorDataDirs()).toEqual([]);
  });

  it("returns path when Cursor directory exists", () => {
    const { getCursorDataDirs } = _testing;
    let cursorDir: string;
    if (process.platform === "darwin") {
      cursorDir = path.join(tmpDir, "Library", "Application Support", "Cursor");
    } else if (process.platform === "win32") {
      cursorDir = path.join(tmpDir, "AppData", "Roaming", "Cursor");
    } else {
      cursorDir = path.join(tmpDir, ".config", "Cursor");
    }
    fs.mkdirSync(cursorDir, { recursive: true });
    const dirs = getCursorDataDirs();
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(cursorDir);
  });
});
