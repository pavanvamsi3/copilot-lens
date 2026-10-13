import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail, SessionMeta } from "../sessions";

vi.mock("../sessions", () => ({ getSession: vi.fn() }));
import { getSession } from "../sessions";
import { SearchIndex } from "../search";

const load = vi.mocked(getSession);
const metas: SessionMeta[] = ["good", "missing", "throws", "bad-event"].map(
  (id) => ({
    id,
    source: "cli",
    cwd: "/fixture",
    status: "completed",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T11:00:00Z",
  })
);
function detail(meta: SessionMeta): SessionDetail {
  return {
    ...meta,
    hasSnapshots: false,
    eventCounts: {},
    duration: 0,
    events: [
      {
        id: "event",
        type: "user.message",
        timestamp: meta.createdAt,
        data: { content: "searchable fixture" },
      },
    ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  load.mockImplementation((id) =>
    detail(metas.find((meta) => meta.id === id)!)
  );
});
afterEach(() => vi.restoreAllMocks());

describe("skipped search sessions", () => {
  it("does not warn for successfully indexed sessions", () => {
    const index = new SearchIndex();
    index.buildIndex(metas);
    expect(index.search("searchable")).toHaveLength(4);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("does not warn for an empty session list", () => {
    const index = new SearchIndex();
    index.buildIndex([]);
    expect(index.search("searchable")).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("counts unreadable and malformed sessions once and keeps valid results", () => {
    load.mockImplementation((id) => {
      if (id === "missing") return null;
      if (id === "throws") throw new Error("private error text");
      const result = detail(metas.find((meta) => meta.id === id)!);
      if (id === "bad-event") result.events[0].data.content = 42;
      return result;
    });
    const index = new SearchIndex();
    index.buildIndex(metas);
    expect(index.search("searchable").map((result) => result.entry.id)).toEqual(
      ["good"]
    );
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "[copilot-lens] search: skipped 3 sessions that could not be loaded or parsed"
    );
  });

  it("uses the singular warning for one missing session", () => {
    load.mockReturnValue(null);
    new SearchIndex().buildIndex([metas[1]]);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "[copilot-lens] search: skipped 1 session that could not be loaded or parsed"
    );
  });

  it("does not repeat a warning when reusing a populated index", () => {
    load.mockImplementation((id) =>
      id === "missing" ? null : detail(metas[0])
    );
    const index = new SearchIndex();
    index.buildIndex(metas.slice(0, 2));
    index.buildIndex(metas.slice(0, 2));
    index.search("searchable");
    expect(load).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("retries all-skipped sessions without repeating an identical warning", () => {
    load.mockReturnValue(null);
    const index = new SearchIndex();
    index.buildIndex([metas[1]]);
    index.search("searchable");
    index.search("searchable");
    expect(load).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(1);
    load.mockReturnValue(detail(metas[1]));
    expect(index.search("searchable")).toHaveLength(1);
  });

  it("reports a fresh count after clear and lazy rebuild", () => {
    load.mockImplementation((id) =>
      id === "missing" ? null : detail(metas[0])
    );
    const index = new SearchIndex();
    index.buildIndex(metas.slice(0, 2));
    load.mockReturnValue(null);
    index.clear();
    expect(index.search("searchable")).toEqual([]);
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenLastCalledWith(
      "[copilot-lens] search: skipped 2 sessions that could not be loaded or parsed"
    );
  });

  it("reports the same skipped count again for a changed session set", () => {
    load.mockReturnValue(null);
    const index = new SearchIndex();
    index.buildIndex([metas[1]]);
    index.buildIndex([{ ...metas[1], updatedAt: "2024-01-16T11:00:00Z" }]);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("reports an unchanged failure again after an explicit clear", () => {
    load.mockReturnValue(null);
    const index = new SearchIndex();
    index.buildIndex([metas[1]]);
    index.clear();
    index.search("searchable");
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it.each([
    { id: "replacement" },
    { source: "vscode" as const },
    { updatedAt: "2024-01-15T10:30:00Z" },
  ])("distinguishes failed sets with equal cheap signatures: %j", (change) => {
    load.mockReturnValue(null);
    const older = { ...metas[1], updatedAt: "2024-01-15T10:00:00Z" };
    const index = new SearchIndex();
    index.buildIndex([metas[0], older]);
    index.buildIndex([metas[0], { ...older, ...change }]);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("does not repeat an identical failed-set warning when enumeration order changes", () => {
    load.mockReturnValue(null);
    const sessions = metas.slice(0, 2);
    const index = new SearchIndex();
    index.buildIndex(sessions);
    index.buildIndex([...sessions].reverse());
    expect(load).toHaveBeenCalledTimes(4);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
