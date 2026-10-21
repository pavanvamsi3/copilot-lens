import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import * as path from "path";
import { runInNewContext } from "vm";
import ts from "typescript";

const source = readFileSync(path.resolve("public/app.js"), "utf8");
const ast = ts.createSourceFile(
  "app.js",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS
);
const names = [
  "loadSessions",
  "csvCell",
  "getSessionCsvModel",
  "reduceSessionCsvRow",
  "buildSessionsCsv",
  "loadSessionCsvDetails",
  "updateSessionCsvExportButton",
  "setSessionSnapshotValid",
  "setSearchPending",
  "clearSearch",
  "exportFilteredSessions",
];
const code = ast.statements
  .filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) &&
      !!node.name &&
      names.includes(node.name.text)
  )
  .map((node) => node.getText(ast))
  .join("\n");
const runSearchCode = ast.statements
  .filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "runSearch"
  )
  .map((node) => node.getText(ast))
  .join("\n");

function context(overrides: Record<string, unknown> = {}) {
  return {
    Blob,
    encodeURIComponent,
    clearTimeout,
    setTimeout: (callback: () => void) => callback(),
    ...overrides,
  };
}

describe("filtered session CSV export", () => {
  it("builds the requested columns from real session-detail fields", () => {
    const csv = runInNewContext(
      `${code}\nbuildSessionsCsv([session])`,
      context({
        session: {
          id: "session-1",
          createdAt: "2026-10-21T01:02:03.000Z",
          source: "claude-code",
          status: "completed",
          duration: 90_000,
          cwd: "/workspace/project",
          eventCounts: { "tool.execution_start": 2 },
          events: [
            { type: "session.start", data: { model: "claude-sonnet" } },
            { type: "session.model_change", data: { newModel: "claude-opus" } },
          ],
        },
      })
    );
    expect(csv).toBe(
      '"Date","Source","Model","Status","Duration (min)","Tool Count","Directory"\r\n' +
        '"2026-10-21T01:02:03.000Z","claude-code","claude-opus","completed","1.50","2","/workspace/project"\r\n'
    );
  });

  it("quotes CSV metacharacters and neutralizes spreadsheet formulas", () => {
    const csv = runInNewContext(
      `${code}\nbuildSessionsCsv([session])`,
      context({
        session: {
          createdAt: "2026-10-21",
          source: "cli",
          status: "completed",
          duration: 0,
          cwd: '=HYPERLINK("https://example.test","click")\nfolder',
          events: [],
        },
      })
    );
    expect(csv).toContain(
      '"\'=HYPERLINK(""https://example.test"",""click"")\nfolder"'
    );
  });

  it("neutralizes formulas after leading control whitespace", () => {
    const csv = runInNewContext(
      `${code}\nbuildSessionsCsv([session])`,
      context({
        session: {
          source: "cli",
          cwd: '\t\r=HYPERLINK("https://example.test")',
          events: [],
        },
      })
    );

    expect(csv).toContain('"\'\t\r=HYPERLINK(""https://example.test"")"');
  });

  it("downloads only the filtered rows and revokes the object URL", async () => {
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    const createObjectURL = vi.fn(() => "blob:csv");
    const revokeObjectURL = vi.fn();
    const button = { disabled: false };
    const status = { hidden: false, textContent: "old" };
    const link = { href: "", download: "", hidden: false, click, remove };
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        id: url.endsWith("keep") ? "keep" : "unexpected",
        createdAt: "2026-10-21T00:00:00Z",
        source: "vscode",
        status: "completed",
        duration: 60_000,
        cwd: "/kept",
        eventCounts: { "tool.execution_start": 1 },
        events: [],
      }),
    }));
    await runInNewContext(
      `${code}\nexportFilteredSessions()`,
      context({
        fetch,
        isSearchActive: false,
        isSearchPending: false,
        isSessionListLoading: false,
        isSessionSnapshotValid: true,
        isSessionCsvExporting: false,
        searchResultSessions: [],
        getFilteredSessions: () => [{ id: "keep" }],
        document: {
          getElementById: (id: string) =>
            id === "exportSessionsCsvBtn" ? button : status,
          createElement: () => link,
          body: { appendChild },
        },
        URL: { createObjectURL, revokeObjectURL },
      })
    );
    expect(fetch).toHaveBeenCalledWith("/api/sessions/keep");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(link.download).toBe("sessions-filtered.csv");
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:csv");
    expect(button.disabled).toBe(false);
    expect(status.hidden).toBe(true);
  });

  it("exports the visible full-text search results instead of metadata matches", async () => {
    const fetched: string[] = [];
    const button = { disabled: false };
    const status = { hidden: false, textContent: "" };
    await runInNewContext(
      `${code}\nexportFilteredSessions()`,
      context({
        fetch: vi.fn(async (url: string) => {
          fetched.push(url);
          return { ok: false };
        }),
        isSearchActive: true,
        isSearchPending: false,
        isSessionListLoading: false,
        isSessionSnapshotValid: true,
        isSessionCsvExporting: false,
        searchResultSessions: [{ id: "full-text-hit" }],
        sessions: [],
        getFilteredSessions: () => [{ id: "metadata-hit" }],
        document: {
          getElementById: (id: string) =>
            id === "exportSessionsCsvBtn" ? button : status,
          createElement: () => ({
            href: "",
            download: "",
            hidden: false,
            click: vi.fn(),
            remove: vi.fn(),
          }),
          body: { appendChild: vi.fn() },
        },
        URL: { createObjectURL: () => "blob:csv", revokeObjectURL: vi.fn() },
      })
    );
    expect(fetched).toEqual(["/api/sessions/full-text-hit"]);
  });

  it("merges list metadata into full-text search exports", async () => {
    const button = { disabled: false };
    const status = { hidden: false, textContent: "" };
    let exportedBlob: Blob | undefined;

    await runInNewContext(
      `${code}\nexportFilteredSessions()`,
      context({
        fetch: vi.fn(async () => ({ ok: false })),
        isSearchActive: true,
        isSearchPending: false,
        isSessionListLoading: false,
        isSessionSnapshotValid: true,
        isSessionCsvExporting: false,
        searchResultSessions: [
          {
            id: "full-text-hit",
            source: "vscode",
            date: "search-index-date",
          },
        ],
        sessions: [
          {
            id: "full-text-hit",
            source: "vscode",
            createdAt: "2026-10-21T01:02:03.000Z",
            status: "completed",
          },
        ],
        getFilteredSessions: () => [],
        document: {
          getElementById: (id: string) =>
            id === "exportSessionsCsvBtn" ? button : status,
          createElement: () => ({
            href: "",
            download: "",
            hidden: false,
            click: vi.fn(),
            remove: vi.fn(),
          }),
          body: { appendChild: vi.fn() },
        },
        URL: {
          createObjectURL: (blob: Blob) => {
            exportedBlob = blob;
            return "blob:csv";
          },
          revokeObjectURL: vi.fn(),
        },
      })
    );

    expect(exportedBlob).toBeDefined();
    const csv = await exportedBlob!.text();
    expect(csv).toContain('"2026-10-21T01:02:03.000Z","vscode","","completed"');
  });

  it("leaves tool count blank when session details cannot be loaded", async () => {
    const rows = await runInNewContext(
      `${code}\nloadSessionCsvDetails([{ id: "gone", source: "vscode" }])`,
      context({ fetch: vi.fn(async () => ({ ok: false })) })
    );
    const csv = runInNewContext(
      `${code}\nbuildSessionsCsv(rows)`,
      context({ rows })
    );

    expect(csv).toContain('"vscode","","","","",""');
  });

  it("retains metadata fallbacks and discards loaded event payloads", async () => {
    const rows = await runInNewContext(
      `${code}\nloadSessionCsvDetails([metadata])`,
      context({
        metadata: {
          id: "vscode-session",
          createdAt: "2026-10-21T01:02:03.000Z",
          source: "vscode",
          status: "completed",
          cwd: "/workspace/project",
        },
        fetch: vi.fn(async () => ({
          ok: true,
          json: async () => ({
            createdAt: "",
            source: "vscode",
            status: "completed",
            duration: 60_000,
            cwd: "",
            events: [
              {
                type: "assistant.thinking",
                data: { model: "claude-sonnet-4-6", content: "large" },
              },
              { type: "tool.execution_start", data: { tool: "bash" } },
            ],
          }),
        })),
      })
    );

    expect(rows).toEqual([
      {
        createdAt: "2026-10-21T01:02:03.000Z",
        source: "vscode",
        model: "claude-sonnet-4-6",
        status: "completed",
        duration: 60_000,
        toolCount: 1,
        cwd: "/workspace/project",
      },
    ]);
    expect(rows[0]).not.toHaveProperty("events");
    expect(rows[0]).not.toHaveProperty("eventCounts");
  });

  it("does not export while full-text search results are pending", async () => {
    const fetch = vi.fn();
    const createObjectURL = vi.fn();
    const button = { disabled: false };
    const status = { hidden: true, textContent: "" };

    await runInNewContext(
      `${code}\nexportFilteredSessions()`,
      context({
        fetch,
        isSearchActive: false,
        isSearchPending: true,
        isSessionListLoading: false,
        isSessionSnapshotValid: false,
        isSessionCsvExporting: false,
        searchResultSessions: [],
        getFilteredSessions: () => [{ id: "metadata-only" }],
        document: {
          getElementById: (id: string) =>
            id === "exportSessionsCsvBtn" ? button : status,
        },
        URL: { createObjectURL, revokeObjectURL: vi.fn() },
      })
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("Wait for search results");
  });

  it("does not export while the session list is loading", async () => {
    const fetch = vi.fn();
    const createObjectURL = vi.fn();
    const button = { disabled: false };
    const status = { hidden: true, textContent: "" };

    await runInNewContext(
      `${code}\nexportFilteredSessions()`,
      context({
        fetch,
        isSearchActive: false,
        isSearchPending: false,
        isSessionListLoading: true,
        isSessionSnapshotValid: false,
        isSessionCsvExporting: false,
        searchResultSessions: [],
        getFilteredSessions: () => [{ id: "stale" }],
        document: {
          getElementById: (id: string) =>
            id === "exportSessionsCsvBtn" ? button : status,
        },
        URL: { createObjectURL, revokeObjectURL: vi.fn() },
      })
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    expect(status.textContent).toContain("sessions to finish loading");
  });

  it("does not export after a list or search failure", async () => {
    const fetch = vi.fn();
    const button = { disabled: false };
    const status = { hidden: true, textContent: "" };

    await runInNewContext(
      `${code}\nexportFilteredSessions()`,
      context({
        fetch,
        isSearchActive: true,
        isSearchPending: false,
        isSessionListLoading: false,
        isSessionSnapshotValid: false,
        isSessionCsvExporting: false,
        searchResultSessions: [],
        getFilteredSessions: () => [{ id: "stale" }],
        document: {
          getElementById: (id: string) =>
            id === "exportSessionsCsvBtn" ? button : status,
        },
      })
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    expect(status.textContent).toContain("Reload sessions");
  });

  it("refreshes active full-text results after reloading sessions", async () => {
    const button = { disabled: false };
    const renderSessions = vi.fn();
    const updateDirFilter = vi.fn();
    const vmContext: Record<string, unknown> = context({
      sessionLoadGeneration: 0,
      isSessionListLoading: false,
      hasSuccessfulSessionLoad: false,
      isSessionSnapshotValid: false,
      isSearchActive: true,
      isSearchPending: false,
      searchGeneration: 7,
      searchDebounce: null,
      isSessionCsvExporting: false,
      sessions: [{ id: "stale" }],
      bookmarks: {},
      searchInput: { value: "message-only hit" },
      sessionList: { innerHTML: "" },
      fetch: vi.fn(async () => ({
        json: async () => [{ id: "fresh", bookmarked: false }],
      })),
      loadBookmarks: vi.fn(async () => undefined),
      updateDirFilter,
      renderSessions,
      escapeHtml: (value: string) => value,
      document: { getElementById: () => button },
    });
    const runSearch = vi.fn(async () => {
      vmContext.isSearchPending = false;
      vmContext.isSessionSnapshotValid = true;
    });
    vmContext.runSearch = runSearch;

    await runInNewContext(`${code}\nloadSessions()`, vmContext);

    expect(runSearch).toHaveBeenCalledWith("message-only hit", 8);
    expect(renderSessions).not.toHaveBeenCalled();
    expect(updateDirFilter).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(false);
  });

  it("restores the unfiltered snapshot when a refreshed search is cleared", async () => {
    const button = { disabled: false };
    const searchInput = { value: "message-only hit" };
    let finishSearch: (() => void) | undefined;
    const vmContext: Record<string, unknown> = context({
      sessionLoadGeneration: 0,
      isSessionListLoading: false,
      hasSuccessfulSessionLoad: false,
      isSessionSnapshotValid: false,
      isSearchActive: true,
      isSearchPending: false,
      searchGeneration: 7,
      searchDebounce: null,
      isSessionCsvExporting: false,
      sessions: [{ id: "stale" }],
      bookmarks: {},
      searchInput,
      sessionList: { innerHTML: "" },
      fetch: vi.fn(async () => ({
        json: async () => [{ id: "fresh", bookmarked: false }],
      })),
      loadBookmarks: vi.fn(async () => undefined),
      updateDirFilter: vi.fn(),
      renderSessions: vi.fn(),
      escapeHtml: (value: string) => value,
      document: {
        getElementById: () => button,
        querySelector: () => null,
      },
    });
    vmContext.runSearch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSearch = resolve;
        })
    );

    const load = runInNewContext(`${code}\nloadSessions()`, vmContext);
    await vi.waitFor(() => expect(vmContext.runSearch).toHaveBeenCalled());

    searchInput.value = "";
    runInNewContext("clearSearch()", vmContext);
    expect(vmContext.isSessionSnapshotValid).toBe(false);

    finishSearch?.();
    await load;

    expect(vmContext.isSessionSnapshotValid).toBe(true);
    expect(button.disabled).toBe(false);
  });

  it("cancels a queued search before refresh reruns the active query", async () => {
    const button = { disabled: false };
    const queuedSearch = Symbol("queued-search");
    const clearTimeout = vi.fn();
    const vmContext: Record<string, unknown> = context({
      clearTimeout,
      sessionLoadGeneration: 0,
      isSessionListLoading: false,
      hasSuccessfulSessionLoad: false,
      isSessionSnapshotValid: false,
      isSearchActive: true,
      isSearchPending: true,
      searchGeneration: 7,
      searchDebounce: queuedSearch,
      isSessionCsvExporting: false,
      sessions: [],
      bookmarks: {},
      searchInput: { value: "new query" },
      sessionList: { innerHTML: "" },
      fetch: vi.fn(async () => ({
        json: async () => [{ id: "fresh", bookmarked: false }],
      })),
      loadBookmarks: vi.fn(async () => undefined),
      updateDirFilter: vi.fn(),
      renderSessions: vi.fn(),
      escapeHtml: (value: string) => value,
      document: { getElementById: () => button },
    });
    vmContext.runSearch = vi.fn(async () => {
      vmContext.isSearchPending = false;
      vmContext.isSessionSnapshotValid = true;
    });

    await runInNewContext(`${code}\nloadSessions()`, vmContext);

    expect(clearTimeout).toHaveBeenCalledWith(queuedSearch);
    expect(vmContext.searchDebounce).toBeNull();
    expect(vmContext.runSearch).toHaveBeenCalledWith("new query", 8);
  });

  it("clears stale search results when refresh wins the empty-query debounce", async () => {
    const button = { disabled: false };
    const queuedClear = Symbol("queued-clear");
    const clearTimeout = vi.fn();
    const renderSessions = vi.fn();
    const vmContext: Record<string, unknown> = context({
      clearTimeout,
      sessionLoadGeneration: 0,
      isSessionListLoading: false,
      hasSuccessfulSessionLoad: false,
      isSessionSnapshotValid: false,
      isSearchActive: true,
      isSearchPending: false,
      searchGeneration: 8,
      searchDebounce: queuedClear,
      isSessionCsvExporting: false,
      searchResultSessions: [{ id: "stale-search-hit" }],
      sessions: [{ id: "stale" }],
      bookmarks: {},
      searchInput: { value: "" },
      sessionList: { innerHTML: "" },
      fetch: vi.fn(async () => ({
        json: async () => [{ id: "fresh", bookmarked: false }],
      })),
      loadBookmarks: vi.fn(async () => undefined),
      updateDirFilter: vi.fn(),
      renderSessions,
      escapeHtml: (value: string) => value,
      document: {
        getElementById: () => button,
        querySelector: () => null,
      },
    });

    await runInNewContext(`${code}\nloadSessions()`, vmContext);

    expect(clearTimeout).toHaveBeenCalledWith(queuedClear);
    expect(vmContext.searchDebounce).toBeNull();
    expect(vmContext.searchGeneration).toBe(9);
    expect(vmContext.isSearchActive).toBe(false);
    expect(vmContext.searchResultSessions).toEqual([]);
    expect(renderSessions).toHaveBeenCalledOnce();
    expect(vmContext.isSessionSnapshotValid).toBe(true);
    expect(button.disabled).toBe(false);
  });

  it("ignores a stale search before showing its loading indicator", async () => {
    const add = vi.fn();
    const remove = vi.fn();
    const fetch = vi.fn();

    await runInNewContext(
      `${runSearchCode}\nrunSearch("old query", 6)`,
      context({
        searchGeneration: 7,
        fetch,
        document: {
          querySelector: () => ({ classList: { add, remove } }),
          getElementById: () => ({ disabled: false }),
        },
      })
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
