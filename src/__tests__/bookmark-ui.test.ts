import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import * as path from "path";
import * as vm from "vm";
import ts from "typescript";

// Execute the shipped handlers; do not duplicate their bookmark logic in tests.
const source = readFileSync(path.resolve("public/app.js"), "utf8");
const ast = ts.createSourceFile(
  "app.js",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS
);
const handlers = ast.statements
  .filter(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) &&
      !!s.name &&
      ["toggleBookmark", "saveBookmarkDetail"].includes(s.name.text)
  )
  .map((s) => s.getText(ast))
  .join("\n");
function harness(selected: string | null, existing = false, ok = true) {
  const state = {
    bookmarks: (existing
      ? { s1: { tags: ["original"], note: "original" } }
      : {}) as Record<string, unknown>,
    sessions: [
      { id: "s1", bookmarked: existing, tags: existing ? ["original"] : [] },
    ],
    fetch: vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => ({ tags: ["new"], note: "new" }),
    })),
    loadBookmarks: vi.fn(async () => {}),
    renderSessions: vi.fn(() => {
      selected = null;
    }),
    sessionList: {
      querySelector: () => (selected ? { dataset: { id: selected } } : null),
    },
    refreshDetailBookmarkSection: vi.fn(),
  };
  const context = vm.createContext(state);
  vm.runInContext(handlers, context);
  return {
    state,
    run: (code: string) => vm.runInContext(code, context) as Promise<void>,
  };
}
describe("bookmark UI regressions", () => {
  it.each([false, true])(
    "refreshes the open detail after toggling an existing=%s bookmark",
    async (existing) => {
      const h = harness("s1", existing);
      await h.run('toggleBookmark("s1")');
      expect(h.state.refreshDetailBookmarkSection).toHaveBeenCalledWith("s1");
    }
  );
  it("does not refresh a different session's detail", async () => {
    const h = harness("other");
    await h.run('toggleBookmark("s1")');
    expect(h.state.refreshDetailBookmarkSection).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "rejects failed toggle requests without changing existing=%s state",
    async (existing) => {
      const h = harness("s1", existing, false);
      const before = JSON.stringify(h.state.bookmarks);
      await expect(h.run('toggleBookmark("s1")')).rejects.toThrow();
      expect(JSON.stringify(h.state.bookmarks)).toBe(before);
      expect(h.state.renderSessions).not.toHaveBeenCalled();
    }
  );
  it("rejects failed detail saves without mutating bookmark or session state", async () => {
    const h = harness("s1", true, false);
    const before = JSON.stringify({
      bookmarks: h.state.bookmarks,
      sessions: h.state.sessions,
    });
    await expect(
      h.run('saveBookmarkDetail("s1", ["new"], "new")')
    ).rejects.toThrow();
    expect(
      JSON.stringify({
        bookmarks: h.state.bookmarks,
        sessions: h.state.sessions,
      })
    ).toBe(before);
    expect(h.state.loadBookmarks).not.toHaveBeenCalled();
  });
});
