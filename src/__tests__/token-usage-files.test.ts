import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "path";
import { clearCache } from "../cache";
import { getLogsDir, getTokenUsage } from "../token-usage";

const files = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  ...files,
}));

const MAX_LOG_SIZE = 200 * 1024 * 1024;
const RESPONSE = `2026-01-22T18:34:17.358Z [DEBUG] response (Request-ID fixture):
2026-01-22T18:34:17.358Z [DEBUG] data:
2026-01-22T18:34:17.358Z [DEBUG] {
  "model": "fixture-model",
  "usage": { "prompt_tokens": 100, "completion_tokens": 25 }
}
`;

beforeEach(() => {
  vi.resetAllMocks();
  clearCache();
  // No real session files are accessed, including the other source collector.
  files.existsSync.mockImplementation((file) => file === getLogsDir());
  files.readdirSync.mockReturnValue(["usage.log"]);
  files.readFileSync.mockReturnValue(RESPONSE);
});

afterEach(() => clearCache());

describe("Copilot CLI token log size limit", () => {
  it.each([
    [MAX_LOG_SIZE - 1, 1],
    [MAX_LOG_SIZE, 1],
    [MAX_LOG_SIZE + 1, 0],
  ])("collects %i-byte files only within the limit", (size, calls) => {
    files.statSync.mockReturnValue({ size });

    const result = getTokenUsage("copilot-cli");

    expect(result.totals.calls).toBe(calls);
    expect(result.totals.total_tokens).toBe(calls * 125);
    expect(files.readFileSync).toHaveBeenCalledTimes(calls);
    // Keep the existing count of discovered logs, including skipped files.
    expect(result.logsScanned).toBe(1);
  });

  it("continues to valid logs after an oversized or unstatable file", () => {
    files.readdirSync.mockReturnValue(["large.log", "gone.log", "valid.log"]);
    files.statSync.mockImplementation((file) => {
      const name = path.basename(file);
      if (name === "gone.log")
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return {
        size: name === "large.log" ? MAX_LOG_SIZE + 1 : RESPONSE.length,
      };
    });

    const result = getTokenUsage("copilot-cli");

    expect(result.totals.calls).toBe(1);
    expect(result.logsScanned).toBe(3);
    expect(files.readFileSync).toHaveBeenCalledExactlyOnceWith(
      path.join(getLogsDir(), "valid.log"),
      "utf-8"
    );
  });
});
