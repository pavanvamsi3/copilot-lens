import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
  id: `session-${String(i).padStart(2, "0")}`,
  title: i === 44 ? "needle expert" : `Fixture ${i}`,
  cwd: "/fixture",
  source: sources[i % sources.length],
  status: "completed",
  createdAt: "2024-01-15T10:00:00Z",
  updatedAt: "2024-01-15T11:00:00Z",
}));
const rankedSessions = [sessions[44], ...sessions.slice(0, 44)];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  vi.mocked(listSessions).mockReturnValue(sessions);
  vi.mocked(getSession).mockImplementation((id) => {
    const meta = sessions.find((session) => session.id === id);
    if (!meta) return null;
    return {
      ...meta,
      events: [
        {
          id: "fixture-event",
          timestamp: meta.createdAt,
          type: "user.message",
          data: { content: "needle" },
        },
      ],
      duration: 0,
      hasSnapshots: false,
      eventCounts: {},
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
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
);

beforeEach(() => vi.mocked(listSessions).mockClear());

describe("search index pagination", () => {
  it("slices pages after ranking the full match set", () => {
    const index = new SearchIndex();
    index.buildIndex(sessions);
    const all = index.search("needle", { limit: 100 });
    expect(all[0].entry.id).toBe(sessions[44].id);
    expect(index.search("needle", { offset: 20, limit: 20 })).toEqual(
      all.slice(20, 40)
    );
  });

  it("returns an empty page beyond the matches", () => {
    const index = new SearchIndex();
    index.buildIndex(sessions);
    expect(index.search("needle", { offset: 45 })).toEqual([]);
  });
});

describe("GET /api/search pagination", () => {
  it("keeps the default 20-result array response", async () => {
    const response = await fetch(`${baseUrl}/api/search?q=needle`);
    const results = (await response.json()) as SearchResult[];
    expect(response.status).toBe(200);
    expect(results.map((result) => result.entry.id)).toEqual(
      rankedSessions.slice(0, 20).map((session) => session.id)
    );
    expect(results[0]).toMatchObject({ score: 1.5, highlights: ["needle"] });
  });

  it("returns matches 21-40 for offset=20&limit=20", async () => {
    const response = await fetch(
      `${baseUrl}/api/search?q=needle&offset=20&limit=20`
    );
    const results = (await response.json()) as SearchResult[];
    expect(response.status).toBe(200);
    expect(results.map((result) => result.entry.id)).toEqual(
      rankedSessions.slice(20, 40).map((session) => session.id)
    );
  });

  it("applies the offset within the selected source", async () => {
    const response = await fetch(
      `${baseUrl}/api/search?q=needle&source=claude-code&offset=10&limit=10`
    );
    const results = (await response.json()) as SearchResult[];
    const filtered = rankedSessions.filter(
      (session) => session.source === "claude-code"
    );
    expect(results.map((result) => result.entry.id)).toEqual(
      filtered.slice(10, 20).map((session) => session.id)
    );
  });

  it("accepts the maximum page size", async () => {
    const response = await fetch(
      `${baseUrl}/api/search?q=needle&offset=0&limit=100`
    );
    const results = (await response.json()) as SearchResult[];
    expect(response.status).toBe(200);
    expect(results).toHaveLength(45);
  });

  it("returns an empty array beyond the last page", async () => {
    const response = await fetch(`${baseUrl}/api/search?q=needle&offset=100`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("returns an empty array without loading sessions for a blank query", async () => {
    const response = await fetch(`${baseUrl}/api/search?q=&offset=20&limit=20`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it.each([
    "limit=-1",
    "limit=0",
    "limit=101",
    "limit=two",
    "limit=2.5",
    "limit=20junk",
    "limit=1e2",
    "limit=0x10",
    "limit=20&limit=30",
    "offset=-1",
    "offset=text",
    "offset=1.5",
    "offset=2junk",
    "offset=9007199254740992",
    "offset=3&offset=4",
  ])("rejects invalid %s before loading sessions", async (query) => {
    const response = await fetch(`${baseUrl}/api/search?q=needle&${query}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
    expect(listSessions).not.toHaveBeenCalled();
  });
});
