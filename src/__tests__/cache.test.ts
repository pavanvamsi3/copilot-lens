import { describe, it, expect, beforeEach } from "vitest";
import { cachedCall, clearCache, _cacheInternals } from "../cache";

beforeEach(() => {
  clearCache();
});

describe("cachedCall", () => {
  it("returns the computed value on first call", () => {
    const result = cachedCall("test-key", 1000, () => 42);
    expect(result).toBe(42);
  });

  it("returns cached value on subsequent calls", () => {
    let callCount = 0;
    const fn = () => ++callCount;

    const first = cachedCall("counter", 1000, fn);
    const second = cachedCall("counter", 1000, fn);

    expect(first).toBe(1);
    expect(second).toBe(1); // cached, fn not called again
    expect(callCount).toBe(1);
  });

  it("recomputes after TTL expires", () => {
    let callCount = 0;
    const fn = () => ++callCount;

    cachedCall("expire-test", 1000, fn);

    // Manually expire the entry
    const entry = _cacheInternals.cache.get("expire-test")!;
    entry.expiresAt = Date.now() - 1;

    const result = cachedCall("expire-test", 1000, fn);
    expect(result).toBe(2); // fn called again
    expect(callCount).toBe(2);
  });

  it("uses separate keys for different caches", () => {
    const a = cachedCall("key-a", 1000, () => "alpha");
    const b = cachedCall("key-b", 1000, () => "beta");

    expect(a).toBe("alpha");
    expect(b).toBe("beta");
  });

  it("caches complex objects", () => {
    const obj = { items: [1, 2, 3], nested: { x: true } };
    const result = cachedCall("obj", 1000, () => obj);
    expect(result).toEqual(obj);
    expect(result).toBe(obj); // same reference
  });
});

describe("clearCache", () => {
  it("invalidates all cached entries", () => {
    let callCount = 0;
    const fn = () => ++callCount;

    cachedCall("clear-test", 1000, fn);
    expect(callCount).toBe(1);

    clearCache();

    cachedCall("clear-test", 1000, fn);
    expect(callCount).toBe(2); // recomputed after clear
  });

  it("works when cache is empty", () => {
    expect(() => clearCache()).not.toThrow();
  });
});
