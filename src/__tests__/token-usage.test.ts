import { describe, it, expect, beforeEach } from "vitest";
import { parseLogContent, normalizeModelName, aggregate } from "../token-usage";
import { clearCache } from "../cache";

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
});
