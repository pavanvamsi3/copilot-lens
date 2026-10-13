import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import type { SessionMeta, SessionDetail } from "../sessions";
import type { SearchResult } from "../search";

vi.mock("../sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessions")>()),
  listSessions: vi.fn(),
  getSession: vi.fn(),
}));

import { getSession, listSessions } from "../sessions";
import { SearchIndex, tokenize } from "../search";
import { createApp } from "../server";

const fixtures = [
  { id: "content-upper", content: "HTTPServer responds" },
  { id: "content-lower", content: "httpserver responds" },
  { id: "content-mixed", content: "HttpServer responds" },
  { id: "title-upper", title: "HTTPServer" },
  { id: "title-lower", title: "httpserver" },
  { id: "cwd-upper", cwd: "/HTTPServer" },
  { id: "cwd-lower", cwd: "/httpserver" },
  {
    id: "highlight",
    content: "httpserver ".repeat(30) + "HTTPServer responds",
  },
  { id: "unicode-upper", content: "École" },
  { id: "unicode-lower", content: "école" },
  { id: "unicode-title-upper", title: "École" },
  { id: "unicode-title-lower", title: "école" },
  { id: "unicode-cwd-upper", cwd: "/École" },
  { id: "unicode-cwd-lower", cwd: "/école" },
  { id: "decomposed-upper", content: "E\u0301cole" },
  { id: "decomposed-lower", content: "e\u0301cole" },
  { id: "unicode-number", content: "１２３" },
];
const sessions: SessionMeta[] = fixtures.map((fixture) => ({
  id: fixture.id,
  title: fixture.title ?? "Fixture",
  cwd: fixture.cwd ?? "/fixture",
  source: "cli",
  status: "completed",
  createdAt: "2024-01-15T10:00:00Z",
  updatedAt: "2024-01-15T11:00:00Z",
}));

let server: Server;
let baseUrl: string;
let index: SearchIndex;

beforeAll(async () => {
  vi.mocked(listSessions).mockReturnValue(sessions);
  vi.mocked(getSession).mockImplementation((id) => {
    const meta = sessions.find((session) => session.id === id);
    const fixture = fixtures.find((entry) => entry.id === id);
    if (!meta || !fixture) return null;
    return {
      ...meta,
      events: [
        {
          id: "fixture-event",
          timestamp: meta.createdAt,
          type: "user.message",
          data: { content: fixture.content ?? "unrelated text" },
        },
      ],
      duration: 0,
      hasSnapshots: false,
      eventCounts: {},
    } satisfies SessionDetail;
  });
  index = new SearchIndex();
  index.buildIndex(sessions);
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
);

describe("case-sensitive search", () => {
  it("retains Unicode letters, numbers, and combining marks in exact-case tokens", () => {
    expect(tokenize("École １２３ e\u0301cole", true)).toEqual([
      "École",
      "１２３",
      "e\u0301cole",
    ]);
    expect(tokenize("École")).toEqual(["cole"]); // Existing default parsing.
  });

  it.each<[string, string[]]>([
    ["École", ["unicode-cwd-upper", "unicode-title-upper", "unicode-upper"]],
    ["école", ["unicode-cwd-lower", "unicode-lower", "unicode-title-lower"]],
    ["E\u0301cole", ["decomposed-upper"]],
    ["e\u0301cole", ["decomposed-lower"]],
    ["１２３", ["unicode-number"]],
  ])(
    "matches the complete Unicode token %s with exact case",
    (query, expected) => {
      const results = index.search(query, { caseSensitive: true });
      expect(results.map((result) => result.entry.id).sort()).toEqual(expected);
    }
  );

  it("preserves Unicode query case through HTTP and in highlights", async () => {
    const response = await fetch(
      `${baseUrl}/api/search?q=${encodeURIComponent("École")}&caseSensitive=true`
    );
    const results = (await response.json()) as SearchResult[];
    expect(response.status).toBe(200);
    expect(results.map((result) => result.entry.id).sort()).toEqual([
      "unicode-cwd-upper",
      "unicode-title-upper",
      "unicode-upper",
    ]);
    const content = results.find(
      (result) => result.entry.id === "unicode-upper"
    )!;
    expect(content.highlights).toEqual(["École"]);
  });

  it("preserves query token case only when requested", () => {
    expect(tokenize("HTTPServer_42 CodeX")).toEqual([
      "httpserver",
      "42",
      "codex",
    ]);
    expect(tokenize("HTTPServer_42 CodeX", true)).toEqual([
      "HTTPServer",
      "42",
      "CodeX",
    ]);
  });

  it("keeps default and explicit insensitive results identical", () => {
    const results = index.search("HTTPServer");
    expect(results).toHaveLength(8);
    expect(index.search("HTTPServer", { caseSensitive: false })).toEqual(
      results
    );
  });

  it.each<[string, string[]]>([
    ["HTTPServer", ["content-upper", "cwd-upper", "highlight", "title-upper"]],
    ["httpserver", ["content-lower", "cwd-lower", "highlight", "title-lower"]],
    ["HttpServer", ["content-mixed"]],
  ])(
    "matches exact case in content, title, and cwd for %s",
    (query, expected) => {
      const results = index.search(query, { caseSensitive: true });
      expect(results.map((result) => result.entry.id).sort()).toEqual(expected);
    }
  );

  it("finds highlights at the case-sensitive match instead of earlier folded matches", () => {
    const result = index
      .search("HTTPServer", { caseSensitive: true })
      .find((match) => match.entry.id === "highlight")!;
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0]).toContain("HTTPServer");
  });

  it.each<[string, number]>([
    ["", 8],
    ["&caseSensitive=false", 8],
    ["&caseSensitive=true", 4],
  ])(
    "passes the %s HTTP query option through to search",
    async (options, count) => {
      const response = await fetch(
        `${baseUrl}/api/search?q=HTTPServer${options}`
      );
      const results = (await response.json()) as SearchResult[];
      expect(response.status).toBe(200);
      expect(results).toHaveLength(count);
      if (count === 4) {
        expect(results.map((result) => result.entry.id).sort()).toEqual([
          "content-upper",
          "cwd-upper",
          "highlight",
          "title-upper",
        ]);
      }
    }
  );
});
