import { describe, it, expect } from "vitest";
import { _testing } from "../sessions";

const { durationPercentile, summarizeDurations } = _testing;

describe("duration percentiles", () => {
  it("returns zero percentiles when no sessions have duration data", () => {
    expect(summarizeDurations([])).toEqual({
      avgDuration: 0,
      minDuration: 0,
      maxDuration: 0,
      p50Duration: 0,
      p90Duration: 0,
      p99Duration: 0,
      totalDuration: 0,
    });
  });

  it("uses the single duration for every percentile", () => {
    expect(durationPercentile([42_000], 0.5)).toBe(42_000);
    expect(durationPercentile([42_000], 0.9)).toBe(42_000);
    expect(durationPercentile([42_000], 0.99)).toBe(42_000);
  });

  it("calculates nearest-rank duration percentiles without mutating input", () => {
    const durations = [100, 10, 90, 20, 80, 30, 70, 40, 60, 50];

    expect(durationPercentile(durations, 0.5)).toBe(50);
    expect(durationPercentile(durations, 0.9)).toBe(90);
    expect(durationPercentile(durations, 0.99)).toBe(100);
    expect(durations).toEqual([100, 10, 90, 20, 80, 30, 70, 40, 60, 50]);
  });
});
