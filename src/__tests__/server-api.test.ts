import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnalyticsData,
  RepoScore,
  SessionDetail,
  SessionMeta,
} from "../sessions";
import type { TokenUsageAnalytics } from "../token-usage";

const searchMocks = vi.hoisted(() => ({
  buildIndex: vi.fn(),
  searchPage: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("../sessions", () => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getAnalytics: vi.fn(),
  listReposWithScores: vi.fn(),
  getRepoScore: vi.fn(),
  getVSCodeScore: vi.fn(),
}));

vi.mock("../cache", () => ({
  clearCache: vi.fn(),
}));

vi.mock("../search", () => ({
  SearchIndex: class {
    buildIndex = searchMocks.buildIndex;
    searchPage = searchMocks.searchPage;
    clear = searchMocks.clear;
  },
}));

vi.mock("../token-usage", () => ({
  getTokenUsage: vi.fn(),
  getTokenUsageCsv: vi.fn(),
}));

vi.mock("../bookmarks", () => ({
  listBookmarks: vi.fn(() => []),
  getBookmark: vi.fn(() => null),
  upsertBookmark: vi.fn(),
  deleteBookmark: vi.fn(),
  getBookmarkMap: vi.fn(),
  listAllTags: vi.fn(() => []),
}));

import {
  getAnalytics,
  getSession,
  listReposWithScores,
  listSessions,
} from "../sessions";
import { clearCache } from "../cache";
import { getTokenUsage } from "../token-usage";
import { getBookmarkMap } from "../bookmarks";
import { createApp } from "../server";

const session: SessionMeta = {
  id: "session-1",
  cwd: "/workspace/copilot-lens",
  gitRoot: "/workspace/copilot-lens",
  branch: "main",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:05:00.000Z",
  status: "completed",
  source: "cli",
  title: "Investigate a needle in the API",
};

const sessionDetail: SessionDetail = {
  ...session,
  events: [
    {
      type: "user.message",
      id: "event-1",
      timestamp: session.createdAt,
      data: { content: "Find the needle in this session" },
    },
  ],
  hasSnapshots: false,
  eventCounts: { "user.message": 1 },
  duration: 300_000,
};

const analytics: AnalyticsData = {
  totalSessions: 1,
  sessionsPerDay: { "2026-10-20": 1 },
  avgDuration: 300_000,
  minDuration: 300_000,
  maxDuration: 300_000,
  p50Duration: 300_000,
  p90Duration: 300_000,
  p99Duration: 300_000,
  totalDuration: 300_000,
  toolUsage: { shell: 2 },
  topDirectories: { "/workspace/copilot-lens": 1 },
  branchTime: { main: 300_000 },
  repoTime: { "/workspace/copilot-lens": 300_000 },
  modelUsage: { "gpt-5": 1 },
  mcpServers: {},
  toolSuccessRate: { shell: { success: 2, failure: 0 } },
  turnsPerSession: [2],
  hourOfDay: { "10": 1 },
  errorTypes: {},
};

const category = {
  score: 18,
  maxScore: 20,
  label: "Test category",
  detail: "Fixture score",
};
const repoScore: RepoScore = {
  repo: "/workspace/copilot-lens",
  totalScore: 90,
  sessionCount: 3,
  categories: {
    promptQuality: category,
    toolUtilization: category,
    efficiency: category,
    mcpUtilization: category,
    engagement: category,
  },
  tips: ["Keep it up"],
};

const tokenUsage: TokenUsageAnalytics = {
  totals: {
    calls: 2,
    prompt_tokens: 100,
    cached_tokens: 20,
    completion_tokens: 50,
    total_tokens: 150,
    cache_hit_rate: 0.2,
    active_days: 1,
    avg_per_day: 150,
    top_model: "gpt-5",
    estimatedCostUSD: null,
  },
  byModel: {
    "gpt-5": {
      calls: 2,
      prompt_tokens: 100,
      cached_tokens: 20,
      completion_tokens: 50,
      total_tokens: 150,
    },
  },
  daily: [],
  weekly: [],
  monthly: [],
  logsScanned: 1,
  logsDir: "/tmp/copilot-logs",
  source: "all",
  sources: [],
};

function api() {
  return request(createApp());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listSessions).mockReturnValue([session]);
  vi.mocked(getSession).mockReturnValue(sessionDetail);
  vi.mocked(getAnalytics).mockReturnValue(analytics);
  vi.mocked(listReposWithScores).mockReturnValue([repoScore]);
  vi.mocked(getTokenUsage).mockReturnValue(tokenUsage);
  vi.mocked(getBookmarkMap).mockReturnValue(new Map());
  searchMocks.searchPage.mockReturnValue({
    results: [
      {
        entry: {
          id: session.id,
          source: session.source,
          title: session.title!,
          cwd: session.cwd,
          date: session.updatedAt,
          content: ["Find the needle in this session"],
        },
        score: 1,
        highlights: ["Find the needle in this session"],
      },
    ],
    totalMatches: 1,
  });
});

describe("server API integration", () => {
  it("GET /api/sessions returns session metadata", async () => {
    const response = await api().get("/api/sessions").set("Host", "localhost");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([session]);
    expect(listSessions).toHaveBeenCalledOnce();
  });

  it("GET /api/analytics returns the analytics contract", async () => {
    const response = await api()
      .get("/api/analytics?source=cli")
      .set("Host", "localhost");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      totalSessions: 1,
      sessionsPerDay: analytics.sessionsPerDay,
      toolUsage: analytics.toolUsage,
      modelUsage: analytics.modelUsage,
    });
    expect(getAnalytics).toHaveBeenCalledWith("cli");
  });

  it("GET /api/token-usage returns the token summary", async () => {
    const response = await api()
      .get("/api/token-usage?source=copilot-cli")
      .set("Host", "localhost");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(tokenUsage);
    expect(getTokenUsage).toHaveBeenCalledWith("copilot-cli");
  });

  it("GET /api/search?q=... returns matching sessions", async () => {
    const response = await api()
      .get("/api/search?q=needle")
      .set("Host", "localhost");

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].entry.id).toBe(session.id);
    expect(searchMocks.buildIndex).toHaveBeenCalledWith([session]);
    expect(searchMocks.searchPage).toHaveBeenCalledWith("needle", {
      limit: 20,
      caseSensitive: false,
      offset: 0,
      source: "all",
    });
  });

  it("GET /api/insights/repos returns scores per repository", async () => {
    const response = await api()
      .get("/api/insights/repos")
      .set("Host", "localhost");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([repoScore]);
    expect(listReposWithScores).toHaveBeenCalledOnce();
  });

  it("POST /api/cache/clear clears both caches", async () => {
    const response = await api()
      .post("/api/cache/clear")
      .set("Host", "localhost");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(clearCache).toHaveBeenCalledOnce();
    expect(searchMocks.clear).toHaveBeenCalledOnce();
  });

  it("GET /api/sessions/:id/export returns 404 for an unknown session", async () => {
    vi.mocked(getSession).mockReturnValueOnce(null);

    const response = await api()
      .get("/api/sessions/missing/export")
      .set("Host", "localhost");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Session not found" });
    expect(getSession).toHaveBeenCalledWith("missing");
  });
});
