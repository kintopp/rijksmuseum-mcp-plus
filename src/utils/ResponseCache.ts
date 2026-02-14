/**
 * Simple in-memory LRU + TTL cache.
 *
 * - `get(key)` returns the cached value or undefined (refreshes LRU position).
 * - `set(key, value, ttlMs?)` stores a value with an optional per-entry TTL.
 * - `stats()` returns hit/miss counters and current size.
 *
 * Eviction: expired entries are pruned on access; when maxSize is exceeded
 * the least-recently-used entry (front of the Map) is evicted.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class ResponseCache<T = unknown> {
  private map = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly maxSize: number = 500,
    private readonly defaultTtlMs: number = 300_000 // 5 min
  ) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }

    // Refresh LRU position: delete + re-insert moves to end
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    // Delete first so re-insert goes to end (LRU refresh)
    this.map.delete(key);

    // Evict oldest if at capacity
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }

    this.map.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  /**
   * Get a cached value or compute it via `fetch`, storing the result.
   * Eliminates the repeated get/check/fetch/set pattern at call sites.
   */
  async getOrFetch<V extends T>(key: string, fetch: () => Promise<V>, ttlMs?: number): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached as V;

    const value = await fetch();
    this.set(key, value, ttlMs);
    return value;
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.map.size };
  }
}
