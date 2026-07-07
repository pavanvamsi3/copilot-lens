import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseLogContent, normalizeModelName, aggregate, parseClaudeCodeJsonl, getTokenUsage } from "../token-usage";
import { clearCache } from "../cache";

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("os");
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const RESPONSE_BLOCK = `2026-01-22T18:34:17.358Z [DEBUG] response (Request-ID 00000-abc):
2026-01-22T18:34:17.358Z [DEBUG] data:
2026-01-22T18:34:17.358Z [DEBUG] {
  "usage": {
    "completion_tokens": 100,
    "prompt_tokens": 1000,
    "prompt_tokens_details": {
      "cached_tokens": 400
    },
    "total_tokens": 1100
  },
  "id": "msg_abc",
  "model": "claude-opus-4.7",
  "copilot_usage": {
    "total_nano_aiu": 1234567
  }
}
2026-01-22T18:34:17.358Z [INFO] --- End of group ---
`;

const RESPONSE_NO_MODEL = `2026-01-23T01:00:00.000Z [DEBUG] streaming chunk:
2026-01-23T01:00:00.001Z [DEBUG] {
  "model": "capi-noe-ptuc-h200-ib-gpt-5-mini-2025-08-07",
  "object": "chat.completion.chunk"
}
2026-01-23T01:00:00.500Z [DEBUG] response (Request-ID 00000-xyz):
2026-01-23T01:00:00.500Z [DEBUG] data:
2026-01-23T01:00:00.500Z [DEBUG] {
  "usage": {
    "completion_tokens": 50,
    "prompt_tokens": 500,
    "total_tokens": 550
  }
}
2026-01-23T01:00:00.501Z [INFO] done
`;

const FALSE_POSITIVE = `2026-01-22T18:00:00.000Z [DEBUG] request config: {
  "max_prompt_tokens": 90000,
  "model": "capi:claude-opus-4.7:defaultReasoningEffort=medium"
}
2026-01-22T18:00:01.000Z [DEBUG] Got model info: {
  "object": "model",
  "model": "claude-opus-4.7"
}
`;

describe("normalizeModelName", () => {
  it("strips capi: prefix and option suffix", () => {
    expect(normalizeModelName("capi:claude-opus-4.7:defaultReasoningEffort=medium")).toBe("claude-opus-4.7");
  });
  it("strips Azure deployment prefix", () => {
    expect(normalizeModelName("capi-noe-ptuc-h200-ib-gpt-5-mini-2025-08-07")).toBe("gpt-5-mini-2025-08-07");
  });
  it("leaves clean model names unchanged", () => {
    expect(normalizeModelName("claude-opus-4.5")).toBe("claude-opus-4.5");
  });
  it("handles empty input", () => {
    expect(normalizeModelName("")).toBe("");
  });
});

describe("parseLogContent", () => {
  beforeEach(() => clearCache());

  it("extracts a basic response block", () => {
    const calls = parseLogContent(RESPONSE_BLOCK);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      request_id: "00000-abc",
      message_id: "msg_abc",
      model: "claude-opus-4.7",
      prompt_tokens: 1000,
      completion_tokens: 100,
      cached_tokens: 400,
      total_tokens: 1100,
    });
  });

  it("falls back to streaming-chunk model via lookback", () => {
    const calls = parseLogContent(RESPONSE_NO_MODEL);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("gpt-5-mini-2025-08-07");
    expect(calls[0].cached_tokens).toBe(0);
  });

  it("ignores request configuration and model catalog blocks", () => {
    expect(parseLogContent(FALSE_POSITIVE)).toHaveLength(0);
  });

  it("parses multiple response blocks", () => {
    const calls = parseLogContent(RESPONSE_BLOCK + RESPONSE_BLOCK);
    expect(calls).toHaveLength(2);
  });
});

describe("aggregate", () => {
  it("computes totals, model breakdown, and bucket data", () => {
    const calls = parseLogContent(RESPONSE_BLOCK + RESPONSE_NO_MODEL);
    const agg = aggregate(calls, 1, "/tmp");
    expect(agg.totals.calls).toBe(2);
    expect(agg.totals.prompt_tokens).toBe(1500);
    expect(agg.totals.completion_tokens).toBe(150);
    expect(agg.totals.cached_tokens).toBe(400);
    expect(agg.totals.cache_hit_rate).toBeCloseTo(400 / 1500);
    expect(agg.totals.top_model).toBe("claude-opus-4.7");
    expect(agg.byModel["claude-opus-4.7"].calls).toBe(1);
    expect(agg.byModel["gpt-5-mini-2025-08-07"].calls).toBe(1);
    expect(agg.daily.length).toBe(2);
    expect(agg.monthly.length).toBe(1);
    expect(agg.daily[0].top_model).toBeTruthy();
  });

  it("handles empty input", () => {
    const agg = aggregate([], 0, "/tmp");
    expect(agg.totals.calls).toBe(0);
    expect(agg.totals.cache_hit_rate).toBe(0);
    expect(agg.totals.top_model).toBeNull();
    expect(agg.daily).toEqual([]);
  });

  it("builds weekly and monthly buckets", () => {
    const calls = parseLogContent(RESPONSE_BLOCK + RESPONSE_NO_MODEL);
    const agg = aggregate(calls, 2, "/tmp");
    expect(agg.weekly.length).toBeGreaterThanOrEqual(1);
    expect(agg.monthly.length).toBeGreaterThanOrEqual(1);
    expect(agg.weekly[0].period).toMatch(/^\d{4}-W\d{2}$/);
    expect(agg.monthly[0].period).toMatch(/^\d{4}-\d{2}$/);
  });

  it("computes per-model token breakdown inside daily buckets", () => {
    const calls = parseLogContent(RESPONSE_BLOCK);
    const agg = aggregate(calls, 1, "/tmp");
    const day = agg.daily[0];
    expect(day.models["claude-opus-4.7"]).toBeDefined();
    expect(day.models["claude-opus-4.7"].prompt_tokens).toBe(1000);
  });
});

// ── parseClaudeCodeJsonl ──────────────────────────────────────────────────────

const CC_ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  uuid: "req-001",
  timestamp: "2026-01-22T18:00:00.000Z",
  message: {
    id: "msg_001",
    model: "claude-sonnet-4-6",
    usage: {
      input_tokens: 500,
      output_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 200,
    },
  },
});

const CC_SIDECHAIN_LINE = JSON.stringify({
  type: "assistant",
  isSidechain: true,
  uuid: "req-002",
  timestamp: "2026-01-22T18:01:00.000Z",
  message: {
    model: "claude-sonnet-4-6",
    usage: { input_tokens: 100, output_tokens: 20 },
  },
});

const CC_SYNTHETIC_LINE = JSON.stringify({
  type: "assistant",
  uuid: "req-003",
  timestamp: "2026-01-22T18:02:00.000Z",
  message: {
    model: "<synthetic>",
    usage: { input_tokens: 10, output_tokens: 5 },
  },
});

describe("parseClaudeCodeJsonl", () => {
  it("parses a valid assistant event", () => {
    const calls = parseClaudeCodeJsonl(CC_ASSISTANT_LINE);
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.source).toBe("claude-code");
    expect(c.model).toBe("claude-sonnet-4-6");
    expect(c.completion_tokens).toBe(100);
    // prompt = input + cacheCreate + cacheRead = 500 + 50 + 200 = 750
    expect(c.prompt_tokens).toBe(750);
    expect(c.cached_tokens).toBe(200);
    expect(c.total_tokens).toBe(850);
    expect(c.request_id).toBe("req-001");
    expect(c.message_id).toBe("msg_001");
  });

  it("skips sidechain events", () => {
    expect(parseClaudeCodeJsonl(CC_SIDECHAIN_LINE)).toHaveLength(0);
  });

  it("skips events with <synthetic> model", () => {
    expect(parseClaudeCodeJsonl(CC_SYNTHETIC_LINE)).toHaveLength(0);
  });

  it("skips non-assistant events", () => {
    const line = JSON.stringify({ type: "user", message: { text: "hi" } });
    expect(parseClaudeCodeJsonl(line)).toHaveLength(0);
  });

  it("skips events with no usage", () => {
    const line = JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-6" } });
    expect(parseClaudeCodeJsonl(line)).toHaveLength(0);
  });

  it("skips events where total tokens is zero", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { model: "claude-sonnet-4-6", usage: { input_tokens: 0, output_tokens: 0 } },
    });
    expect(parseClaudeCodeJsonl(line)).toHaveLength(0);
  });

  it("skips malformed JSON lines", () => {
    const content = "not json\n" + CC_ASSISTANT_LINE;
    expect(parseClaudeCodeJsonl(content)).toHaveLength(1);
  });

  it("parses multiple valid lines", () => {
    const second = JSON.stringify({
      type: "assistant",
      uuid: "req-004",
      timestamp: "2026-01-22T19:00:00.000Z",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 200, output_tokens: 50 },
      },
    });
    const calls = parseClaudeCodeJsonl([CC_ASSISTANT_LINE, second].join("\n"));
    expect(calls).toHaveLength(2);
    expect(calls[1].model).toBe("claude-opus-4-8");
  });

  it("handles missing timestamp gracefully", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "req-005",
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    });
    const calls = parseClaudeCodeJsonl(line);
    expect(calls).toHaveLength(1);
    expect(calls[0].timestamp).toBe("");
  });
});

// ── getTokenUsage ─────────────────────────────────────────────────────────────

describe("getTokenUsage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-lens-tok-"));
    vi.mocked(os.homedir).mockReturnValue(tmpDir);
    clearCache();
  });

  afterEach(() => {
    vi.mocked(os.homedir).mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearCache();
  });

  it("returns zero totals when no log files exist", () => {
    const result = getTokenUsage();
    expect(result.totals.calls).toBe(0);
    expect(result.source).toBe("all");
  });

  it("reads copilot-cli log files and returns parsed calls", () => {
    const logsDir = path.join(tmpDir, ".copilot", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "session.log"), RESPONSE_BLOCK);

    const result = getTokenUsage("copilot-cli");
    expect(result.totals.calls).toBe(1);
    expect(result.source).toBe("copilot-cli");
    expect(result.totals.prompt_tokens).toBe(1000);
  });

  it("reads claude-code JSONL files and returns parsed calls", () => {
    const projectsDir = path.join(tmpDir, ".claude", "projects", "my-project");
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(path.join(projectsDir, "session.jsonl"), CC_ASSISTANT_LINE);

    const result = getTokenUsage("claude-code");
    expect(result.totals.calls).toBe(1);
    expect(result.source).toBe("claude-code");
    expect(result.totals.completion_tokens).toBe(100);
  });

  it("merges both sources when source is 'all'", () => {
    const logsDir = path.join(tmpDir, ".copilot", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "session.log"), RESPONSE_BLOCK);

    const projectsDir = path.join(tmpDir, ".claude", "projects", "my-project");
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(path.join(projectsDir, "session.jsonl"), CC_ASSISTANT_LINE);

    const result = getTokenUsage("all");
    expect(result.totals.calls).toBe(2);
    expect(result.sources).toHaveLength(2);
  });

  it("returns cached result on second call", () => {
    const result1 = getTokenUsage();
    const result2 = getTokenUsage();
    expect(result1).toBe(result2);
  });
});
