import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import type { SessionMeta } from "../sessions";

vi.mock("../sessions", async (original) => ({
  ...(await original<typeof import("../sessions")>()),
  listSessions: vi.fn(),
  getSession: vi.fn(() => null),
}));

import { listSessions, getSession } from "../sessions";
import { createApp } from "../server";

const fixture: SessionMeta[] = ["cli", "vscode", "claude-code"].map(
  (source, index) => ({
    id: `session-${index}`,
    source: source as SessionMeta["source"],
    title: `Quotes " and newline\nwith Unicode 日本語 ${index}`,
    cwd: "/workspace/project",
    status: "completed",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    summaryCount: index,
    branch: "main",
  })
);

let server: Server;
let url: string;
beforeAll(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
);
beforeEach(() => {
  vi.mocked(listSessions).mockReset().mockReturnValue(fixture);
  vi.mocked(getSession).mockClear();
});

describe("all-session metadata JSON download", () => {
  it("downloads the complete metadata array across sources with a fixed filename", async () => {
    const response = await fetch(`${url}/api/sessions/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="?sessions\.json"?$/
    );
    expect(await response.json()).toEqual(fixture);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("exports all sessions independently of display filter query parameters", async () => {
    const response = await fetch(
      `${url}/api/sessions/export?source=cli&limit=1`
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(fixture);
  });

  it("returns an empty JSON array when no sessions are available", async () => {
    vi.mocked(listSessions).mockReturnValue([]);
    const response = await fetch(`${url}/api/sessions/export`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("returns a server error without an attachment when enumeration fails", async () => {
    vi.mocked(listSessions).mockImplementation(() => {
      throw new Error("Session directory unavailable");
    });
    const response = await fetch(`${url}/api/sessions/export`);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toEqual({
      error: "Session directory unavailable",
    });
  });

  it("keeps the regular session-list endpoint unchanged", async () => {
    const response = await fetch(`${url}/api/sessions`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toEqual(fixture);
  });
});
