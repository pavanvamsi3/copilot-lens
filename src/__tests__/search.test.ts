import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionMeta, SessionDetail } from "../sessions";

// Must mock before importing the module under test
vi.mock("../sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions")>();
  return {
    ...actual,
    getSession: vi.fn(),
    listSessions: vi.fn(),
  };
});

import { SearchIndex, tokenize } from "../search";
import { getSession } from "../sessions";

const mockGetSession = vi.mocked(getSession);

// Helpers to build minimal SessionMeta and SessionDetail fixtures
function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "sess-001",
    cwd: "/home/user/project",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T11:00:00Z",
    status: "completed",
    source: "cli",
    ...overrides,
  };
}

function makeDetail(
  meta: SessionMeta,
  messages: Array<{ type: "user.message" | "assistant.message"; content: string }>
): SessionDetail {
  return {
    ...meta,
    events: messages.map((m, i) => ({
      type: m.type,
      id: `event-${i}`,
      timestamp: meta.createdAt,
      data: { content: m.content },
    })),
    hasSnapshots: false,
    eventCounts: {},
    duration: 0,
  };
}

// ─── Test 1: tokenize ────────────────────────────────────────────────────────

describe("tokenize", () => {
  it("strips punctuation, lowercases, and removes tokens under 2 chars", () => {
    const result = tokenize("Hello, World! A 42 foo-bar");
    expect(result).toContain("hello");
    expect(result).toContain("world");
    expect(result).toContain("42");
    expect(result).toContain("foo");
    expect(result).toContain("bar");
    // Single char 'a' should be removed
    expect(result).not.toContain("a");
    // Output should be lowercased
    expect(result).not.toContain("Hello");
    expect(result).not.toContain("World");
  });
});

// ─── Tests 2 & 3: Empty / blank query ───────────────────────────────────────

describe("SearchIndex.search — empty/blank query", () => {
  let index: SearchIndex;

  beforeEach(() => {
    index = new SearchIndex();
    const meta = makeMeta();
    mockGetSession.mockReturnValue(
      makeDetail(meta, [{ type: "user.message", content: "hello world" }])
    );
    index.buildIndex([meta]);
  });

  it("returns [] for empty string", () => {
    expect(index.search("")).toEqual([]);
  });

  it("returns [] for blank string (spaces only)", () => {
    expect(index.search("   ")).toEqual([]);
  });
});

// ─── Test 4: Title match scores higher than content-only ─────────────────────

describe("SearchIndex.search — scoring", () => {
  it("session with query token in title scores higher than content-only match", () => {
    const index = new SearchIndex();
    const metaTitle = makeMeta({ id: "title-sess", title: "typescript refactor", cwd: "/a/b" });
    const metaContent = makeMeta({ id: "content-sess", title: "random session", cwd: "/c/d" });

    mockGetSession.mockImplementation((id) => {
      if (id === "title-sess") {
        return makeDetail(metaTitle, [
          { type: "user.message", content: "please help me with typescript refactor here" },
        ]);
      }
      return makeDetail(metaContent, [
        { type: "user.message", content: "please help me with typescript refactor here" },
      ]);
    });

    index.buildIndex([metaTitle, metaContent]);
    const results = index.search("typescript");

    expect(results.length).toBeGreaterThanOrEqual(2);
    const titleResult = results.find((r) => r.entry.id === "title-sess")!;
    const contentResult = results.find((r) => r.entry.id === "content-sess")!;
    expect(titleResult.score).toBeGreaterThan(contentResult.score);
  });

// ─── Test 5: cwd match scores higher than content-only ────────────────────

  it("cwd match scores higher than content-only match", () => {
    const index = new SearchIndex();
    const metaCwd = makeMeta({ id: "cwd-sess", cwd: "/home/user/typescript-project", title: "sess1" });
    const metaContent = makeMeta({ id: "plain-sess", cwd: "/home/user/other", title: "sess2" });

    mockGetSession.mockImplementation((id) => {
      if (id === "cwd-sess") {
        return makeDetail(metaCwd, [
          { type: "user.message", content: "help with typescript" },
        ]);
      }
      return makeDetail(metaContent, [
        { type: "user.message", content: "help with typescript" },
      ]);
    });

    index.buildIndex([metaCwd, metaContent]);
    const results = index.search("typescript");

    expect(results.length).toBeGreaterThanOrEqual(2);
    const cwdResult = results.find((r) => r.entry.id === "cwd-sess")!;
    const plainResult = results.find((r) => r.entry.id === "plain-sess")!;
    expect(cwdResult.score).toBeGreaterThan(plainResult.score);
  });
});

// ─── Test 6: Highlight extraction ───────────────────────────────────────────

describe("SearchIndex.search — highlights", () => {
  it("highlight snippet is at most 121 chars (±60 around match)", () => {
    const index = new SearchIndex();
    const meta = makeMeta();
    // Long content with a searchable word in the middle
    const padding = "word ".repeat(20); // 100 chars before and after
    const content = `${padding}targetword ${padding}`;
    mockGetSession.mockReturnValue(
      makeDetail(meta, [{ type: "user.message", content }])
    );
    index.buildIndex([meta]);
    const results = index.search("targetword");
    expect(results.length).toBe(1);
    expect(results[0].highlights.length).toBeGreaterThan(0);
    for (const snippet of results[0].highlights) {
      // ±60 chars around a 10-char token = max 121 chars before word-boundary trimming
      expect(snippet.length).toBeLessThanOrEqual(121);
    }
  });
});

// ─── Tests 7 & 8: source filter ─────────────────────────────────────────────

describe("SearchIndex.search — source filter", () => {
  let index: SearchIndex;
  const metaCli = makeMeta({ id: "cli-sess", source: "cli", cwd: "/cli/proj" });
  const metaVscode = makeMeta({ id: "vscode-sess", source: "vscode", cwd: "/vscode/proj" });

  beforeEach(() => {
    index = new SearchIndex();
    mockGetSession.mockImplementation((id) => {
      if (id === "cli-sess") {
        return makeDetail(metaCli, [{ type: "user.message", content: "hello from cli session" }]);
      }
      return makeDetail(metaVscode, [{ type: "user.message", content: "hello from vscode session" }]);
    });
    index.buildIndex([metaCli, metaVscode]);
  });

  it("source:'cli' excludes vscode entries", () => {
    const results = index.search("hello", { source: "cli" });
    expect(results.every((r) => r.entry.source === "cli")).toBe(true);
    expect(results.some((r) => r.entry.id === "cli-sess")).toBe(true);
    expect(results.some((r) => r.entry.id === "vscode-sess")).toBe(false);
  });

  it("source:'vscode' excludes cli entries", () => {
    const results = index.search("hello", { source: "vscode" });
    expect(results.every((r) => r.entry.source === "vscode")).toBe(true);
    expect(results.some((r) => r.entry.id === "vscode-sess")).toBe(true);
    expect(results.some((r) => r.entry.id === "cli-sess")).toBe(false);
  });
});

// ─── Test 9: clear() causes rebuild ─────────────────────────────────────────

describe("SearchIndex.clear()", () => {
  it("causes next search() call to rebuild the index", () => {
    const index = new SearchIndex();
    const meta = makeMeta({ id: "rebuild-sess" });

    // First build: content has "apple"
    mockGetSession.mockReturnValue(
      makeDetail(meta, [{ type: "user.message", content: "I love apple pie" }])
    );
    index.buildIndex([meta]);
    expect(index.search("apple")).toHaveLength(1);
    expect(index.search("mango")).toHaveLength(0);

    // Clear and update the mock to return different content
    index.clear();
    mockGetSession.mockReturnValue(
      makeDetail(meta, [{ type: "user.message", content: "I love mango juice" }])
    );

    // Next search() should lazy-rebuild from storedSessions
    const afterClear = index.search("mango");
    expect(afterClear).toHaveLength(1);

    // "apple" no longer in index
    expect(index.search("apple")).toHaveLength(0);
  });
});

// ─── Test 10: limit option ───────────────────────────────────────────────────

describe("SearchIndex.search — limit option", () => {
  it("respects limit option and does not exceed it", () => {
    const index = new SearchIndex();
    const metas = Array.from({ length: 10 }, (_, i) =>
      makeMeta({ id: `sess-${i}`, cwd: `/proj/${i}`, title: `session ${i}` })
    );

    mockGetSession.mockImplementation((id) => {
      const meta = metas.find((m) => m.id === id)!;
      return makeDetail(meta, [
        { type: "user.message", content: "common keyword everywhere" },
      ]);
    });

    index.buildIndex(metas);
    const results = index.search("common", { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
