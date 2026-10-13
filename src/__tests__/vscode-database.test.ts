import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { _testing } from "../vscode-sessions";

const state = vi.hoisted(() => ({
  openError: undefined as unknown,
  queryError: undefined as unknown,
  existsSync: vi.fn(),
  prepare: vi.fn(),
  get: vi.fn(),
  close: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  existsSync: state.existsSync,
}));
vi.mock("better-sqlite3", () => ({
  default: vi.fn(function DatabaseMock() {
    if (state.openError !== undefined) throw state.openError;
    return { prepare: state.prepare, close: state.close };
  }),
}));

const warning =
  "[copilot-lens] VS Code database is locked — close VS Code or wait a moment and retry";
const entry = {
  sessionId: "fixture",
  title: "Fixture",
  lastMessageDate: 0,
  isEmpty: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.openError = state.queryError = undefined;
  state.existsSync.mockReturnValue(true);
  state.prepare.mockReturnValue({ get: state.get });
  state.get.mockImplementation(() => {
    if (state.queryError !== undefined) throw state.queryError;
    return { value: JSON.stringify({ entries: { fixture: entry } }) };
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe.each(["open", "query"] as const)(
  "VS Code database %s errors",
  (stage) => {
    it.each([
      "EBUSY",
      "SQLITE_BUSY",
      "SQLITE_LOCKED",
      "SQLITE_BUSY_RECOVERY",
      "SQLITE_BUSY_SNAPSHOT",
      "SQLITE_LOCKED_SHAREDCACHE",
      "SQLITE_LOCKED_VTAB",
    ])("warns specifically for %s", (code) => {
      const error = Object.assign(new Error("fixture failure"), { code });
      if (stage === "open") state.openError = error;
      else state.queryError = error;

      expect(_testing.readSessionIndex("fixture-data")).toEqual([]);
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning);
      expect(state.close).toHaveBeenCalledTimes(stage === "query" ? 1 : 0);
    });

    it.each(["ENOENT", "EACCES", "SQLITE_CORRUPT", "SQLITE_BUSYISH"])(
      "keeps %s failures silent",
      (code) => {
        const error = Object.assign(new Error("fixture failure"), { code });
        if (stage === "open") state.openError = error;
        else state.queryError = error;

        expect(_testing.readSessionIndex("fixture-data")).toEqual([]);
        expect(console.warn).not.toHaveBeenCalled();
        expect(state.close).toHaveBeenCalledTimes(stage === "query" ? 1 : 0);
      }
    );
  }
);

it("keeps a missing database silent without trying to open it", () => {
  state.existsSync.mockReturnValue(false);
  expect(_testing.readSessionIndex("fixture-data")).toEqual([]);
  expect(Database).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
});

it("returns the stored session index and closes the database", () => {
  expect(_testing.readSessionIndex("fixture-data")).toEqual([entry]);
  expect(state.close).toHaveBeenCalledTimes(1);
  expect(console.warn).not.toHaveBeenCalled();
});

it("keeps malformed index JSON silent after closing the database", () => {
  state.get.mockReturnValue({ value: "invalid json" });
  expect(_testing.readSessionIndex("fixture-data")).toEqual([]);
  expect(state.close).toHaveBeenCalledTimes(1);
  expect(console.warn).not.toHaveBeenCalled();
});
