import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("os", async original => ({ ...await original<typeof import("os")>(), homedir: () => fixture.home }));
import { getTokenUsage, parseCopilotCliEventsJsonl } from "../token-usage";
import { clearCache } from "../cache";
const timestamp = "2026-01-22T18:34:17.358Z";
function shutdown(overrides = {}) {
  return { type: "session.shutdown", id: "session-1", timestamp, data: { sessionStartTime: Date.parse(timestamp), modelMetrics: { "model-a": { requests: { count: 1, cost: 1 }, usage: { inputTokens: 1000, outputTokens: 100 } } } }, ...overrides };
}
beforeEach(() => { fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-regression-")); clearCache(); });
afterEach(() => { clearCache(); fs.rmSync(fixture.home, { recursive: true, force: true }); });
describe("shutdown usage regression fixtures", () => {
  it("does not count legacy response usage again when the same session has a shutdown summary", () => {
    const logs = path.join(fixture.home, ".copilot", "logs");
    const sessions = path.join(fixture.home, ".copilot", "session-state", "session-1");
    fs.mkdirSync(logs, { recursive: true }); fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(logs, "session-1.log"), `${timestamp} [DEBUG] response (Request-ID request-1):\n${timestamp} [DEBUG] data:\n${timestamp} [DEBUG] {\n  "usage": {"prompt_tokens": 1000, "completion_tokens": 100, "total_tokens": 1100},\n  "model": "model-a",\n  "id": "message-1"\n}\n${timestamp} [INFO] --- End of group ---\n`);
    fs.writeFileSync(path.join(sessions, "events.jsonl"), JSON.stringify(shutdown()));
    expect(getTokenUsage("copilot-cli").totals).toMatchObject({ calls: 1, prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 });
  });
  it("rejects an invalid shutdown timestamp before aggregation", () => {
    expect(parseCopilotCliEventsJsonl(JSON.stringify(shutdown({ timestamp: "invalid-date" })))).toEqual([]);
  });
  it("an invalid fallback time cannot hide a later valid shutdown event", () => {
    const bad = shutdown();
    delete (bad as { timestamp?: string }).timestamp;
    bad.data.sessionStartTime = 9e15;
    const calls = parseCopilotCliEventsJsonl(JSON.stringify(bad) + "\n" + JSON.stringify(shutdown()));
    expect(calls).toHaveLength(1);
    expect(calls[0].timestamp).toBe(timestamp);
  });
});


it("keeps unrelated legacy sessions even when their model and usage totals match", () => {
  const logs = path.join(fixture.home, ".copilot", "logs");
  const sessions = path.join(fixture.home, ".copilot", "session-state", "session-1");
  fs.mkdirSync(logs, { recursive: true }); fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(logs, "other-session.log"), `${timestamp} [DEBUG] response (Request-ID other-request):\n${timestamp} [DEBUG] data:\n${timestamp} [DEBUG] {\n  "usage": {"prompt_tokens": 1000, "completion_tokens": 100, "total_tokens": 1100},\n  "model": "model-a"\n}\n${timestamp} [INFO] end\n`);
  fs.writeFileSync(path.join(sessions, "events.jsonl"), JSON.stringify(shutdown()));
  expect(getTokenUsage("copilot-cli").totals).toMatchObject({ calls: 2, total_tokens: 2200 });
});
it("uses the latest cumulative shutdown snapshot instead of summing repeated snapshots", () => {
  const dir = path.join(fixture.home, ".copilot", "session-state", "session-1");
  fs.mkdirSync(dir, { recursive: true });
  const later = shutdown({ timestamp: "2026-01-22T18:35:17.358Z" });
  later.data.modelMetrics["model-a"].usage.inputTokens = 2000;
  later.data.modelMetrics["model-a"].requests.count = 2;
  fs.writeFileSync(path.join(dir, "events.jsonl"), JSON.stringify(shutdown()) + "\n" + JSON.stringify(later));
  expect(getTokenUsage("copilot-cli").totals).toMatchObject({ calls: 2, total_tokens: 2100 });
});
