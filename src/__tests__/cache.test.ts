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

  it("evicts the oldest entry when the cache reaches its size limit", () => {
    const { MAX_ENTRIES, cache } = _cacheInternals;

    for (let i = 0; i < MAX_ENTRIES; i++) {
      cachedCall(`key-${i}`, 1000, () => i);
    }
    cachedCall("newest", 1000, () => "newest-value");

    expect(cache.size).toBe(MAX_ENTRIES);
    expect(cache.has("key-0")).toBe(false);
    expect(cache.get("newest")?.value).toBe("newest-value");
  });

  it("recomputes an evicted entry on its next access", () => {
    const { MAX_ENTRIES } = _cacheInternals;
    let callCount = 0;

    cachedCall("oldest", 1000, () => ++callCount);
    for (let i = 1; i <= MAX_ENTRIES; i++) {
      cachedCall(`key-${i}`, 1000, () => i);
    }

    expect(cachedCall("oldest", 1000, () => ++callCount)).toBe(2);
    expect(callCount).toBe(2);
  });

  it("recomputing an existing key at capacity does not evict another entry", () => {
    const { MAX_ENTRIES, cache } = _cacheInternals;

    for (let i = 0; i < MAX_ENTRIES; i++) {
      cachedCall(`key-${i}`, -1, () => i);
    }
    cachedCall("key-0", 1000, () => "refreshed");

    expect(cache.size).toBe(MAX_ENTRIES);
    expect(cache.has("key-1")).toBe(true);
    expect(cache.get("key-0")?.value).toBe("refreshed");
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
