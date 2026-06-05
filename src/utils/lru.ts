/**
 * Get-or-create with insertion-order LRU eviction. Re-inserts an existing entry
 * to bump it to most-recent; evicts the least-recently-used (first) entry once
 * size exceeds `cap`. Used by VocabularyDb.filterArtIds (#79) and
 * UsageStats.recordInput (#378). Exported for tests (test-lru-cache.mjs).
 */
export function lruGetOrCreate<K, V>(
  map: Map<K, V>,
  key: K,
  factory: () => V,
  cap: number,
): V {
  const existing = map.get(key);
  if (existing !== undefined) {
    map.delete(key);
    map.set(key, existing);
    return existing;
  }
  const value = factory();
  map.set(key, value);
  if (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  return value;
}
