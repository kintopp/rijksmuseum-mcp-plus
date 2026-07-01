// ─── Rijksmuseum visual search (website API) ─────────────────────────

import axios from "axios";
import { type SimilarCandidate } from "../similarHtml.js";

interface VisualSearchArtObject {
  objectNumber: string;
  title: string;
  makerSubtitleLine: string;
  objectNodeId: string;
  micrioImage?: { micrioId: string } | null;
}

// Module-scope caches for visual search HTTP calls (objectNumber→nodeId is
// essentially immutable; visual results are stable for the duration of a session).
const nodeIdCache = new Map<string, { value: string | null; expiresAt: number }>();
const visualCache = new Map<string, { value: { candidates: SimilarCandidate[]; totalResults: number; searchUrl: string }; expiresAt: number }>();
const NODE_ID_TTL = 60 * 60_000;  // 1 hour (mapping is immutable)
const VISUAL_TTL = 30 * 60_000;   // 30 min (matches similarPages TTL)

// Sweep expired entries every 60s so these maps stay bounded in a long-lived
// HTTP process — the per-key expiry checks alone never evict keys that are
// never re-requested. Mirrors the oaiPageBuffers sweeper in helpers.ts.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nodeIdCache) if (v.expiresAt <= now) nodeIdCache.delete(k);
  for (const [k, v] of visualCache) if (v.expiresAt <= now) visualCache.delete(k);
}, 60_000).unref();

/** Resolve an objectNumber to the Rijksmuseum website's objectNodeId (hex hash).
 *  Returns null if the artwork is not in the website search index. */
export async function resolveObjectNodeId(objectNumber: string): Promise<string | null> {
  const cached = nodeIdCache.get(objectNumber);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const resp = await axios.get("https://www.rijksmuseum.nl/api/v1/collection/search", {
      params: { query: objectNumber, language: "en", pageSize: 5 },
      timeout: 5000,
    });
    const objs: VisualSearchArtObject[] = resp.data?.artObjects ?? [];
    const match = objs.find(o => o.objectNumber === objectNumber);
    const nodeId = match?.objectNodeId ?? null;
    nodeIdCache.set(objectNumber, { value: nodeId, expiresAt: Date.now() + NODE_ID_TTL });
    return nodeId;
  } catch {
    return null;
  }
}

/** Fetch visual similarity results from the Rijksmuseum website API.
 *  Returns candidates + total count + visual search URL, or empty on failure. */
export async function fetchVisualSimilar(
  objectNodeId: string,
  maxResults: number,
): Promise<{ candidates: SimilarCandidate[]; totalResults: number; searchUrl: string }> {
  const cacheKey = `${objectNodeId}:${maxResults}`;
  const cached = visualCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const searchUrl = `https://www.rijksmuseum.nl/en/collection/visual/search?objectNodeId=${objectNodeId}`;
  try {
    const resp = await axios.get("https://www.rijksmuseum.nl/api/v1/collection/visualsearch", {
      params: { objectNodeId, language: "en", page: 1, pageSize: maxResults },
      timeout: 8000,
    });
    const objs: VisualSearchArtObject[] = resp.data?.artObjects ?? [];
    const hasMore: boolean = resp.data?.hasMoreResults ?? false;

    const candidates: SimilarCandidate[] = objs.map((o, i) => {
      // Extract creator from makerSubtitleLine (format: "Creator Name, date")
      const creator = o.makerSubtitleLine?.split(",")[0]?.trim() ?? "";
      // IIIF thumbnail via micrio — same pattern as our own thumbnails
      const iiifId = o.micrioImage?.micrioId ?? undefined;
      return {
        objectNumber: o.objectNumber,
        title: o.title ?? "",
        creator,
        iiifId,
        score: maxResults - i, // rank-order score (no similarity scores from API)
        url: `https://www.rijksmuseum.nl/en/collection/${o.objectNumber}`,
      };
    });

    const result = {
      candidates,
      totalResults: hasMore ? maxResults + 1 : objs.length, // indicate "more available"
      searchUrl,
    };
    visualCache.set(cacheKey, { value: result, expiresAt: Date.now() + VISUAL_TTL });
    return result;
  } catch {
    return { candidates: [], totalResults: 0, searchUrl };
  }
}
