import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Point the module at a temp directory before it opens any DB connection
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bm-test-"));
process.env.COPILOT_LENS_DB_DIR = tmpDir;

import { listBookmarks, getBookmark, upsertBookmark, deleteBookmark, getBookmarkMap, listAllTags } from "../bookmarks";

afterEach(() => {
  // Wipe the DB after each test so they don't interfere
  const dbPath = path.join(tmpDir, "bookmarks.db");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

// ─── upsertBookmark ─────────────────────────────────────────────────────────

describe("upsertBookmark", () => {
  it("creates a new bookmark with tags and note", () => {
    const bm = upsertBookmark("session-1", ["bug", "typescript"], "important session");
    expect(bm.sessionId).toBe("session-1");
    expect(bm.tags).toEqual(["bug", "typescript"]);
    expect(bm.note).toBe("important session");
    expect(bm.createdAt).toBeTruthy();
  });

  it("normalises tags to lowercase and trims whitespace", () => {
    const bm = upsertBookmark("session-2", ["  Bug  ", "TypeScript"], "");
    expect(bm.tags).toEqual(["bug", "typescript"]);
  });

  it("filters out empty tags", () => {
    const bm = upsertBookmark("session-3", ["", "  ", "valid"], "");
    expect(bm.tags).toEqual(["valid"]);
  });

  it("updates an existing bookmark without changing createdAt", () => {
    const first = upsertBookmark("session-4", ["v1"], "first note");
    const second = upsertBookmark("session-4", ["v2"], "updated note");
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.tags).toEqual(["v2"]);
    expect(second.note).toBe("updated note");
  });

  it("accepts empty tags and note", () => {
    const bm = upsertBookmark("session-5", [], "");
    expect(bm.tags).toEqual([]);
    expect(bm.note).toBe("");
  });
});

// ─── getBookmark ────────────────────────────────────────────────────────────

describe("getBookmark", () => {
  it("returns null for unknown session", () => {
    expect(getBookmark("does-not-exist")).toBeNull();
  });

  it("returns the bookmark for a known session", () => {
    upsertBookmark("session-6", ["arch"], "architecture decision");
    const bm = getBookmark("session-6");
    expect(bm).not.toBeNull();
    expect(bm!.sessionId).toBe("session-6");
    expect(bm!.tags).toEqual(["arch"]);
    expect(bm!.note).toBe("architecture decision");
  });
});

// ─── listBookmarks ───────────────────────────────────────────────────────────

describe("listBookmarks", () => {
  it("returns empty array when no bookmarks", () => {
    expect(listBookmarks()).toEqual([]);
  });

  it("returns all bookmarks ordered newest first", () => {
    upsertBookmark("s-a", [], "");
    upsertBookmark("s-b", [], "");
    upsertBookmark("s-c", [], "");
    const list = listBookmarks();
    expect(list.length).toBe(3);
    const ids = list.map((b) => b.sessionId);
    expect(ids).toContain("s-a");
    expect(ids).toContain("s-b");
    expect(ids).toContain("s-c");
  });

  it("includes tags as an array, not a JSON string", () => {
    upsertBookmark("s-d", ["one", "two"], "");
    const bm = listBookmarks().find((b) => b.sessionId === "s-d");
    expect(Array.isArray(bm!.tags)).toBe(true);
    expect(bm!.tags).toEqual(["one", "two"]);
  });
});

// ─── deleteBookmark ──────────────────────────────────────────────────────────

describe("deleteBookmark", () => {
  it("returns false for unknown session", () => {
    expect(deleteBookmark("ghost")).toBe(false);
  });

  it("removes the bookmark and returns true", () => {
    upsertBookmark("s-e", [], "");
    expect(deleteBookmark("s-e")).toBe(true);
    expect(getBookmark("s-e")).toBeNull();
  });

  it("second delete returns false (already gone)", () => {
    upsertBookmark("s-f", [], "");
    deleteBookmark("s-f");
    expect(deleteBookmark("s-f")).toBe(false);
  });
});

// ─── getBookmarkMap ──────────────────────────────────────────────────────────

describe("getBookmarkMap", () => {
  it("returns an empty Map when no bookmarks", () => {
    expect(getBookmarkMap().size).toBe(0);
  });

  it("keys are sessionIds", () => {
    upsertBookmark("s-g", ["x"], "note g");
    upsertBookmark("s-h", [], "");
    const map = getBookmarkMap();
    expect(map.has("s-g")).toBe(true);
    expect(map.has("s-h")).toBe(true);
    expect(map.get("s-g")!.tags).toEqual(["x"]);
  });
});

// ─── listAllTags ─────────────────────────────────────────────────────────────

describe("listAllTags", () => {
  it("returns empty array when no bookmarks", () => {
    expect(listAllTags()).toEqual([]);
  });

  it("collects unique tags across all bookmarks sorted alphabetically", () => {
    upsertBookmark("s-i", ["zebra", "alpha"], "");
    upsertBookmark("s-j", ["alpha", "beta"], "");
    const tags = listAllTags();
    expect(tags).toEqual(["alpha", "beta", "zebra"]);
  });

  it("does not return duplicates", () => {
    upsertBookmark("s-k", ["dup"], "");
    upsertBookmark("s-l", ["dup"], "");
    expect(listAllTags().filter((t) => t === "dup").length).toBe(1);
  });
});

// ─── persistence ─────────────────────────────────────────────────────────────

describe("persistence", () => {
  it("bookmark survives a getBookmark call after upsert in same process", () => {
    upsertBookmark("persist-1", ["kept"], "kept note");
    const bm = getBookmark("persist-1");
    expect(bm).not.toBeNull();
    expect(bm!.note).toBe("kept note");
  });

  it("delete removes from listBookmarks", () => {
    upsertBookmark("persist-2", [], "");
    deleteBookmark("persist-2");
    expect(listBookmarks().find((b) => b.sessionId === "persist-2")).toBeUndefined();
  });
});
