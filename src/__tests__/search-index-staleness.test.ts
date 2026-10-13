import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail, SessionMeta } from "../sessions";

vi.mock("../sessions", () => ({ getSession: vi.fn() }));

import { getSession } from "../sessions";
import { SearchIndex } from "../search";

const loadSession = vi.mocked(getSession);

function meta(id: string, updatedAt: string): SessionMeta {
  return {
    id,
    updatedAt,
    createdAt: "2026-01-01T00:00:00Z",
    cwd: "/workspace",
    source: "cli",
    status: "completed",
  };
}

function detail(session: SessionMeta, content: string): SessionDetail {
  return {
    ...session,
    events: [
      {
        id: "message",
        type: "user.message",
        timestamp: session.updatedAt,
        data: { content },
      },
    ],
    hasSnapshots: false,
    eventCounts: {},
    duration: 0,
  };
}

describe("SearchIndex cache invalidation", () => {
  let index: SearchIndex;
  let older: SessionMeta;
  let newest: SessionMeta;
  let contents: Map<string, SessionDetail>;

  beforeEach(() => {
    loadSession.mockReset();
    index = new SearchIndex();
    older = meta("older", "2026-01-02T00:00:00Z");
    newest = meta("newest", "2026-01-10T00:00:00Z");
    contents = new Map([
      [older.id, detail(older, "oldneedle")],
      [newest.id, detail(newest, "unrelated content")],
    ]);
    loadSession.mockImplementation((id) => contents.get(id) ?? null);
    index.buildIndex([older, newest]);
    expect(index.search("oldneedle").map((result) => result.entry.id)).toEqual([
      older.id,
    ]);
  });

  it("removes a replaced session when count and newest timestamp are unchanged", () => {
    const replacement = { ...older, id: "replacement" };
    contents.delete(older.id);
    contents.set(replacement.id, detail(replacement, "newneedle"));

    index.buildIndex([replacement, newest]);

    expect(index.search("oldneedle")).toEqual([]);
    expect(index.search("newneedle").map((result) => result.entry.id)).toEqual([
      replacement.id,
    ]);
  });

  it("reloads an updated older session even when it is not the newest", () => {
    const updated = { ...older, updatedAt: "2026-01-03T00:00:00Z" };
    contents.set(updated.id, detail(updated, "newneedle"));

    index.buildIndex([updated, newest]);

    expect(index.search("oldneedle")).toEqual([]);
    expect(index.search("newneedle")[0].entry.date).toBe(updated.updatedAt);
  });

  it.each(["title", "cwd"] as const)(
    "refreshes a changed %s without a timestamp change",
    (field) => {
      const updated = { ...older, [field]: "metadataneedle" };

      index.buildIndex([updated, newest]);

      expect(index.search("metadataneedle")[0]?.entry[field]).toBe(
        "metadataneedle"
      );
    }
  );

  it("refreshes the source filter when a session's source changes", () => {
    index.buildIndex([{ ...older, source: "vscode" }, newest]);

    expect(index.search("oldneedle", { source: "cli" })).toEqual([]);
    expect(index.search("oldneedle", { source: "vscode" })[0]?.entry.id).toBe(
      older.id
    );
  });

  it("reuses the index when unchanged sessions are listed in a different order", () => {
    loadSession.mockClear();

    index.buildIndex([{ ...newest }, { ...older }]);

    expect(loadSession).not.toHaveBeenCalled();
    expect(index.search("oldneedle")[0]?.entry.id).toBe(older.id);
  });

  it("reuses the index when only non-searchable metadata changes", () => {
    loadSession.mockClear();

    index.buildIndex([
      { ...older, status: "running", branch: "feature" },
      newest,
    ]);

    expect(loadSession).not.toHaveBeenCalled();
    expect(index.search("oldneedle")[0]?.entry.id).toBe(older.id);
  });
});
