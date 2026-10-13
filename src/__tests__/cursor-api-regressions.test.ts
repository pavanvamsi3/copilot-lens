import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const fixture = vi.hoisted(() => ({ home: "", tabs: [] as unknown[] }));
vi.mock("os", async (original) => ({
  ...(await original<typeof import("os")>()),
  homedir: () => fixture.home,
}));
vi.mock("better-sqlite3", () => ({
  default: class {
    prepare() {
      return { get: () => ({ value: JSON.stringify({ tabs: fixture.tabs }) }) };
    }
    close() {}
  },
}));
import { getCursorSession, listCursorSessions } from "../cursor-sessions";

beforeEach(() => {
  fixture.home = fs.mkdtempSync(
    path.join(os.tmpdir(), "cursor-api-regression-")
  );
  const root =
    process.platform === "darwin"
      ? path.join(fixture.home, "Library", "Application Support", "Cursor")
      : process.platform === "win32"
        ? path.join(fixture.home, "AppData", "Roaming", "Cursor")
        : path.join(fixture.home, ".config", "Cursor");
  if (process.platform === "win32") vi.stubEnv("APPDATA", path.dirname(root));
  const db = path.join(root, "User", "globalStorage", "state.vscdb");
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(db, "");
  fixture.tabs = [];
});
afterEach(() => {
  fs.rmSync(fixture.home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("Cursor public API timing fixtures", () => {
  it("retains messages without timing and computes zero duration", () => {
    fixture.tabs = [
      {
        tabId: "missing",
        bubbles: [
          { type: "user", text: "question" },
          { type: "ai", text: "answer" },
        ],
      },
    ];
    expect(listCursorSessions()).toMatchObject([
      { id: "missing", createdAt: "", status: "completed" },
    ]);
    const detail = getCursorSession("missing");
    expect(detail).toMatchObject({
      duration: 0,
      eventCounts: { "user.message": 1, "assistant.message": 1 },
    });
    expect(detail?.events.map((e) => e.timestamp)).toEqual(["", ""]);
  });
  it("caps idle gaps while retaining a valid session's messages", () => {
    fixture.tabs = [
      {
        tabId: "valid",
        bubbles: [
          {
            type: "user",
            text: "question",
            timingInfo: { clientStartTime: 1700000000000 },
          },
          {
            type: "ai",
            text: "answer",
            timingInfo: {
              clientStartTime: 1700000600000,
              clientEndTime: 1700000601000,
            },
          },
        ],
      },
    ];
    expect(getCursorSession("valid")?.duration).toBe(300000);
  });
  it("a malformed timestamp cannot abort the list and hide a later valid session", () => {
    fixture.tabs = [
      {
        tabId: "bad",
        lastSendTime: 9e15,
        bubbles: [
          {
            type: "user",
            text: "bad timing",
            timingInfo: { clientStartTime: 9e15 },
          },
        ],
      },
      {
        tabId: "valid",
        bubbles: [
          {
            type: "user",
            text: "valid",
            timingInfo: { clientStartTime: 1700000000000 },
          },
        ],
      },
    ];
    expect(listCursorSessions().map((s) => s.id)).toContain("valid");
  });
  it("malformed bubble timing cannot discard readable conversation content", () => {
    fixture.tabs = [
      {
        tabId: "bad",
        bubbles: [
          {
            type: "user",
            text: "readable",
            timingInfo: { clientStartTime: 9e15 },
          },
        ],
      },
    ];
    expect(getCursorSession("bad")?.events).toMatchObject([
      { data: { content: "readable" } },
    ]);
  });
});
