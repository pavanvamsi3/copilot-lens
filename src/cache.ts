// Simple in-memory TTL cache for expensive computations.
// Single-user local dashboard — no need for external cache.

const cache = new Map<string, { value: unknown; expiresAt: number }>();

export function cachedCall<T>(key: string, ttlMs: number, fn: () => T): T {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiresAt) {
    return entry.value as T;
  }
  const value = fn();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

export function clearCache(): void {
  cache.clear();
}

// Exported for testing
export const _cacheInternals = { cache };
