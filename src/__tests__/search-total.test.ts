import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { runInNewContext } from "vm";
import ts from "typescript";
import type { Server } from "http";
import type { AddressInfo } from "net";
import type { SessionMeta, SessionDetail } from "../sessions";
import type { SearchResult } from "../search";

vi.mock("../sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessions")>()),
  listSessions: vi.fn(),
  getSession: vi.fn(),
}));
import { listSessions, getSession } from "../sessions";
import { SearchIndex } from "../search";
import { createApp } from "../server";

const sources: SessionMeta["source"][] = ["cli", "vscode", "claude-code"];
const sessions: SessionMeta[] = Array.from({ length: 45 }, (_, i) => ({
  id: `fixture-${i}`,
  title: i === 44 ? "needle expert" : `Fixture ${i}`,
  cwd: "/fixture",
  source: sources[i % 3],
  status: "completed",
  createdAt: "2024-01-15T10:00:00Z",
  updatedAt: "2024-01-15T11:00:00Z",
}));
let server: Server;
let baseUrl: string;
beforeAll(async () => {
  vi.mocked(listSessions).mockReturnValue(sessions);
  vi.mocked(getSession).mockImplementation((id) => {
    const meta = sessions.find((session) => session.id === id)!;
    return {
      ...meta,
      hasSnapshots: false,
      eventCounts: {},
      duration: 0,
      events: [
        {
          id: "event",
          timestamp: meta.createdAt,
          type: "user.message",
          data: { content: "needle content" },
        },
      ],
    } satisfies SessionDetail;
  });
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
);

interface Page {
  results: SearchResult[];
  totalMatches: number;
}
async function page(query = "needle", options = ""): Promise<Page> {
  const response = await fetch(
    `${baseUrl}/api/search?q=${encodeURIComponent(query)}&includeTotal=true${options}`
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}

describe("search total matches", () => {
  it("reports all ranked matches before slicing the index result", () => {
    const index = new SearchIndex();
    index.buildIndex(sessions);
    const result = index.searchPage("needle", { offset: 20, limit: 5 });
    expect(result.totalMatches).toBe(45);
    expect(result.results).toHaveLength(5);
    expect(result.results).toEqual(
      index.search("needle", { offset: 20, limit: 5 })
    );
  });

  it("returns the complete HTTP count with the default twenty results", async () => {
    const result = await page();
    expect(result.totalMatches).toBe(45);
    expect(Number.isInteger(result.totalMatches)).toBe(true);
    expect(result.results).toHaveLength(20);
    expect(result.results[0].entry.id).toBe("fixture-44");
  });

  it.each(sources)(
    "counts only the %s source before pagination",
    async (source) => {
      const result = await page("needle", `&source=${source}&offset=8&limit=3`);
      expect(result.totalMatches).toBe(15);
      expect(result.results).toHaveLength(3);
      expect(result.results.every(({ entry }) => entry.source === source)).toBe(
        true
      );
    }
  );

  it("preserves a positive total when the offset is past the final match", async () => {
    expect(await page("needle", "&offset=99")).toEqual({
      results: [],
      totalMatches: 45,
    });
  });

  it.each(["", "absent", "x"])("reports zero for query %j", async (query) => {
    expect(await page(query)).toEqual({ results: [], totalMatches: 0 });
  });

  it("applies case-sensitive matching to the count as well as the page", async () => {
    expect((await page("Needle")).totalMatches).toBe(45);
    expect(await page("Needle", "&caseSensitive=true")).toEqual({
      results: [],
      totalMatches: 0,
    });
  });

  it("keeps the legacy array and individual result structure unchanged", async () => {
    const legacy = await (await fetch(`${baseUrl}/api/search?q=needle`)).json();
    expect(Array.isArray(legacy)).toBe(true);
    expect((await page()).results).toEqual(legacy);
  });

  it.each([false, true])(
    "runs the dashboard against the real API (request fails: %s)",
    async (fails) => {
      if (fails) {
        vi.mocked(listSessions).mockImplementationOnce(() => {
          throw new Error("fixture request failure");
        });
      }
      const source = readFileSync(
        join(__dirname, "..", "..", "public", "app.js"),
        "utf8"
      );
      const ast = ts.createSourceFile(
        "app.js",
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS
      );
      const names = ["runSearch", "renderSearchResults"];
      const code = ast.statements
        .filter(
          (node) =>
            ts.isFunctionDeclaration(node) && names.includes(node.name!.text)
        )
        .map((node) => node.getText(ast))
        .join("\n");
      const sessionCount = { textContent: "" };
      const sessionList = { innerHTML: "", querySelectorAll: () => [] };
      const classList = { add: vi.fn(), remove: vi.fn() };
      const calls: string[] = [];
      await runInNewContext(`${code}\nrunSearch("needle")`, {
        sessionCount,
        sessionList,
        searchInput: { value: "needle" },
        isSearchActive: false,
        document: { querySelector: () => ({ classList }) },
        fetch: (url: string) => {
          calls.push(url);
          return fetch(baseUrl + url);
        },
        getDirColor: () => ({ border: "#000" }),
        formatTime: () => "Fixture time",
        highlightQuery: (text: string) => text,
        escapeHtml: (text: string) => text,
      });
      expect(new URL(calls[0], baseUrl).searchParams.get("includeTotal")).toBe(
        "true"
      );
      if (fails) {
        expect(sessionList.innerHTML).toContain(
          "Search failed: fixture request failure"
        );
        expect(sessionCount.textContent).not.toBe("No results found");
      } else {
        expect(sessionCount.textContent).toBe("20 of 45 results shown");
        expect(
          sessionList.innerHTML.match(/class="session-card"/g) ?? []
        ).toHaveLength(20);
      }
      expect(classList.remove).toHaveBeenCalledWith("loading");
    }
  );
});
