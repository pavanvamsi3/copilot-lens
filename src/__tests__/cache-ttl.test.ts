import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { listSessions, getAnalytics } from "../sessions";
import { getVSCodeAnalytics } from "../vscode-sessions";
import { getClaudeCodeAnalytics } from "../claude-code-sessions";
import { getTokenUsage } from "../token-usage";
import { clearCache } from "../cache";

// Keep every source empty and prevent access to developer session data.
vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  existsSync: vi.fn(() => false),
}));

const cachedReaders: Array<[string, () => unknown]> = [
  ["session listing", listSessions],
  ["combined analytics", getAnalytics],
  ["VS Code analytics", getVSCodeAnalytics],
  ["Claude Code analytics", getClaudeCodeAnalytics],
  ["token usage", getTokenUsage],
];

beforeEach(() => {
  clearCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  clearCache();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("dashboard cache lifetime", () => {
  it.each(cachedReaders)(
    "expires %s after the configured 5 seconds",
    (_name, read) => {
      vi.stubEnv("COPILOT_LENS_CACHE_TTL_MS", "5000");
      const first = read();
      vi.advanceTimersByTime(4999);
      expect(read()).toBe(first);
      vi.advanceTimersByTime(1);
      expect(read()).not.toBe(first);
    }
  );

  it("keeps the existing 30-second lifetime when unset", () => {
    vi.stubEnv("COPILOT_LENS_CACHE_TTL_MS", undefined);
    const first = listSessions();
    vi.advanceTimersByTime(29_999);
    expect(listSessions()).toBe(first);
    vi.advanceTimersByTime(1);
    expect(listSessions()).not.toBe(first);
  });

  it("falls back to 30 seconds for invalid settings", () => {
    vi.stubEnv("COPILOT_LENS_CACHE_TTL_MS", "-1");
    const first = getTokenUsage();
    vi.advanceTimersByTime(29_999);
    expect(getTokenUsage()).toBe(first);
    vi.advanceTimersByTime(1);
    expect(getTokenUsage()).not.toBe(first);
  });

  it("disables caching when the configured lifetime is zero", () => {
    vi.stubEnv("COPILOT_LENS_CACHE_TTL_MS", "0");
    expect(listSessions()).not.toBe(listSessions());
  });
});
