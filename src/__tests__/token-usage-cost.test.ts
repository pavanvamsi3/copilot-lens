import { describe, expect, it } from "vitest";
import { aggregate, type TokenCall } from "../token-usage";

function call(
  model: string,
  cached = 250_000,
  completion = 100_000
): TokenCall {
  return {
    timestamp: "2024-01-15T10:00:00.000Z",
    request_id: "fixture",
    model,
    source: "copilot-cli",
    prompt_tokens: 1_000_000,
    cached_tokens: cached,
    completion_tokens: completion,
    total_tokens: 1_000_000 + completion,
  };
}

function cost(calls: TokenCall[]): number | null {
  return aggregate(calls, 1, "/fixture").totals.estimatedCostUSD;
}

describe("estimated API token cost", () => {
  it.each([
    ["claude-sonnet-4", 3],
    ["gpt-4o", 2.5],
  ] as const)("prices ordinary input for %s", (model, expected) => {
    expect(cost([call(model, 0, 0)])).toBe(expected);
  });

  it.each([
    ["claude-sonnet-4", 3.825],
    ["gpt-4o", 3.1875],
  ] as const)(
    "separates cached input and completion for %s",
    (model, expected) => {
      expect(cost([call(model)])).toBeCloseTo(expected, 10);
    }
  );

  it.each([
    ["claude-sonnet-4", 0.3],
    ["gpt-4o", 1.25],
  ] as const)(
    "does not double-charge fully cached input for %s",
    (model, expected) => {
      expect(cost([call(model, 1_000_000, 0)])).toBe(expected);
    }
  );

  it("sums known models across sources", () => {
    const claude = {
      ...call("claude-sonnet-4"),
      source: "claude-code" as const,
    };
    expect(cost([claude, call("gpt-4o")])).toBeCloseTo(7.0125, 10);
  });

  it.each([
    ["claude-sonnet-4-20250514", 3.825],
    ["gpt-4o-2024-08-06", 3.1875],
    ["gpt-4o-2024-11-20", 3.1875],
    ["capi:claude-sonnet-4:defaultReasoningEffort=medium", 3.825],
    ["capi-noe-ptuc-h200-ib-gpt-4o-2024-08-06", 3.1875],
  ] as const)("recognizes the supported alias %s", (model, expected) => {
    expect(cost([call(model)])).toBeCloseTo(expected, 10);
  });

  it.each([
    "unknown-model",
    "claude-sonnet-42",
    "gpt-4o-mini",
    "gpt-4o-1999-01-01",
    "constructor",
    "toString",
    "__proto__",
  ])("returns null for the unpriced model %s", (model) => {
    expect(cost([call(model)])).toBeNull();
  });

  it("does not report a partial cost when some calls are unpriced", () => {
    expect(cost([call("gpt-4o"), call("unknown-model")])).toBeNull();
  });

  it.each(["constructor", "toString", "__proto__"])(
    "keeps counts for the literal unpriced model name %s",
    (model) => {
      const analytics = aggregate([call(model)], 1, "/fixture");
      expect(analytics.byModel[model]).toMatchObject({
        calls: 1,
        prompt_tokens: 1_000_000,
        completion_tokens: 100_000,
        cached_tokens: 250_000,
        total_tokens: 1_100_000,
      });
      for (const buckets of [
        analytics.daily,
        analytics.weekly,
        analytics.monthly,
      ]) {
        expect(buckets[0].top_model).toBe(model);
        expect(buckets[0].models[model].total_tokens).toBe(1_100_000);
      }
    }
  );

  it("returns zero for no calls", () => {
    expect(cost([])).toBe(0);
  });
});
