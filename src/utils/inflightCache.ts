import { ResponseCache } from "./ResponseCache.js";

/**
 * Cache an async computation with in-flight de-duplication (#378 Step 4).
 *
 * - Returns the cached value on a hit (no recompute).
 * - On a miss, starts `compute()` once and shares that single promise with every
 *   concurrent caller for the same key — so N identical requests that arrive while
 *   the work is in flight pay for it once, not N times. This matters for paths that
 *   `await` before a synchronous, event-loop-blocking scan (e.g. semantic_search
 *   embeds the query, then runs a ~1s vec0 scan): a plain cache can't coalesce them
 *   because both miss before either finishes.
 * - Only successful results are cached; the in-flight slot is always freed, so a
 *   rejection doesn't poison the key.
 *
 * Cache invalidation is by key: include a DB build-id / model-id in the key so a
 * deploy or DB swap can't serve stale results.
 */
export function getOrComputeWithInflight<T>(
  cache: ResponseCache<T>,
  inflight: Map<string, Promise<T>>,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);

  let pending = inflight.get(key);
  if (pending === undefined) {
    pending = compute();
    inflight.set(key, pending);
    pending
      .then(res => cache.set(key, res))
      .catch(() => { /* don't cache failures */ })
      .finally(() => inflight.delete(key));
  }
  return pending;
}
