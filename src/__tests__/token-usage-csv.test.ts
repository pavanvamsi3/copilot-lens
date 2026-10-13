import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as path from "path";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { clearCache } from "../cache";
import {
  getLogsDir,
  getClaudeCodeProjectsDir,
  getTokenUsage,
  getTokenUsageCsv,
} from "../token-usage";
import { createApp } from "../server";

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

function cliRecord(
  timestamp: string,
  model: string,
  prompt: number,
  completion: number,
  cached: number
): string {
  return (
    `${timestamp} [DEBUG] response (Request-ID fixture):\n${timestamp} [DEBUG] data:\n${timestamp} [DEBUG] {\n` +
    JSON.stringify({
      model,
      usage: {
        prompt_tokens: prompt,
        completion_tokens: completion,
        prompt_tokens_details: { cached_tokens: cached },
        total_tokens: prompt + completion,
      },
    }).slice(1) +
    "\n"
  );
}
const cliContent =
  cliRecord("2024-01-15T10:00:00.000Z", 'model, "quoted"\nline', 10, 2, 1) +
  cliRecord("2024-01-15T11:00:00.000Z", "=SUM(1,2)", 20, 3, 4);
const claudeContent = JSON.stringify({
  type: "assistant",
  timestamp: "2024-01-15T10:30:00.000Z",
  uuid: "fixture",
  message: {
    model: "claude-fixture",
    usage: {
      input_tokens: 30,
      output_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
    },
  },
});
const header =
  "timestamp,model,source,prompt_tokens,completion_tokens,cached_tokens,total_tokens\r\n";
const cliFirst =
  '"2024-01-15T10:00:00.000Z","model, ""quoted""\nline","copilot-cli",10,2,1,12\r\n';
const cliSecond =
  '"2024-01-15T11:00:00.000Z","\'=SUM(1,2)","copilot-cli",20,3,4,23\r\n';
const claudeRow =
  '"2024-01-15T10:30:00.000Z","claude-fixture","claude-code",35,5,3,40\r\n';

let server: Server;
let baseUrl: string;
beforeAll(async () => {
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

beforeEach(() => {
  vi.resetAllMocks();
  clearCache();
  const cliDir = getLogsDir();
  const claudeDir = getClaudeCodeProjectsDir();
  files.existsSync.mockImplementation(
    (dir) => dir === cliDir || dir === claudeDir
  );
  files.readdirSync.mockImplementation((dir) => {
    if (dir === cliDir) return ["fixture.log"];
    if (dir === claudeDir)
      return [{ name: "project", isDirectory: () => true }];
    if (dir === path.join(claudeDir, "project"))
      return [{ name: "fixture.jsonl", isFile: () => true }];
    throw new Error("Unexpected fixture directory");
  });
  files.statSync.mockReturnValue({ size: 100 });
  files.readFileSync.mockImplementation((file) =>
    file.endsWith(".jsonl") ? claudeContent : cliContent
  );
});
afterEach(() => {
  clearCache();
  vi.unstubAllEnvs();
});

describe("token usage CSV", () => {
  it("exports individual calls chronologically with quoting and spreadsheet-safe text", () => {
    expect([...getTokenUsageCsv()].join("")).toBe(
      header + cliFirst + claudeRow + cliSecond
    );
  });

  it.each(["copilot-cli", "claude-code"] as const)(
    "honours the %s source filter",
    (source) => {
      expect([...getTokenUsageCsv(source)].join("")).toBe(
        header + (source === "copilot-cli" ? cliFirst + cliSecond : claudeRow)
      );
    }
  );

  it("shares the JSON snapshot without reading log files again", () => {
    const analytics = getTokenUsage();
    expect(analytics.totals).toMatchObject({
      calls: 3,
      prompt_tokens: 65,
      completion_tokens: 10,
      cached_tokens: 8,
      total_tokens: 75,
    });
    const reads = files.readFileSync.mock.calls.length;
    expect([...getTokenUsageCsv()].join("")).toBe(
      header + cliFirst + claudeRow + cliSecond
    );
    expect(files.readFileSync).toHaveBeenCalledTimes(reads);
    expect(getTokenUsage()).toBe(analytics);
  });

  it("returns only the header for empty sources", () => {
    files.existsSync.mockReturnValue(false);
    expect([...getTokenUsageCsv()].join("")).toBe(header);
  });

  it("serves a CSV download with the expected headers", async () => {
    const response = await fetch(`${baseUrl}/api/token-usage?format=csv`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="?token-usage\.csv"?$/
    );
    expect(await response.text()).toBe(
      header + cliFirst + claudeRow + cliSecond
    );
  });

  it("filters the CSV download through the HTTP source option", async () => {
    const response = await fetch(
      `${baseUrl}/api/token-usage?format=csv&source=claude-code`
    );
    expect(await response.text()).toBe(header + claudeRow);
  });

  it("keeps the default JSON response", async () => {
    const response = await fetch(`${baseUrl}/api/token-usage`);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toMatchObject({
      totals: { calls: 3, total_tokens: 75 },
      source: "all",
    });
  });
});
