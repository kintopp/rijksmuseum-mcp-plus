import axios, { AxiosInstance } from "axios";
import https from "node:https";
import { ResponseCache } from "../utils/ResponseCache.js";
import { ArtworkImageInfo, IIIFInfoResponse } from "../types.js";

// ─── Helpers ────────────────────────────────────────────────────────

// Exported for testing
/** Check if a classified_as array contains a given AAT URI */
export function hasClassification(
  classifiedAs: ({ id?: string } | string)[] | undefined,
  aatUri: string
): boolean {
  if (!classifiedAs) return false;
  return classifiedAs.some((c) =>
    typeof c === "string" ? c === aatUri : c.id === aatUri
  );
}

// Exported for testing
/** Normalize a Linked Art field that may be a single object or an array.
 *  JSON-LD allows any relationship to be singular or plural — this guards against it. */
export function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

// Exported for testing
/** Normalize content that may be a string or array (~34 artworks return arrays) */
export function extractContent(content: string | string[] | undefined): string {
  if (content == null) return "";
  return Array.isArray(content) ? content.join("; ") : content;
}

// Exported for testing
/** Extract IIIF identifier from a full IIIF URL */
export function extractIiifId(url: string): string | null {
  const match = url.match(/iiif\.micr\.io\/([^/]+)/);
  return match ? match[1] : null;
}

// Exported for testing
/** Extract the pageToken query parameter from a next-page URL */
export function extractPageToken(nextRef: { id: string } | undefined): string | undefined {
  if (!nextRef?.id) return undefined;
  try {
    const url = new URL(nextRef.id);
    return url.searchParams.get("pageToken") ?? undefined;
  } catch {
    return undefined;
  }
}

// ─── Client ─────────────────────────────────────────────────────────

/**
 * IIIF image client for the Rijksmuseum collection.
 *
 * All metadata resolution (artwork details, search, vocabulary) has moved to
 * VocabularyDb. This client only handles IIIF image operations: info.json
 * fetching, region/thumbnail base64 extraction.
 */
export class RijksmuseumApiClient {
  private http: AxiosInstance;
  private cache: ResponseCache;       // info.json metadata (~500 bytes each)
  private imageCache: ResponseCache;  // full-image base64 (~300-800 KB each)

  private static readonly IIIF_BASE = "https://iiif.micr.io";

  private static readonly TTL_IMAGE = 30 * 60_000;   // 30 min

  constructor(cache?: ResponseCache, imageCache?: ResponseCache) {
    this.cache = cache ?? new ResponseCache(1000, RijksmuseumApiClient.TTL_IMAGE);
    this.imageCache = imageCache ?? new ResponseCache(50, 5 * 60_000); // 50 entries, 5-min TTL
    this.http = axios.create({
      headers: { Accept: "application/ld+json" },
      timeout: 15_000,
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 25 }),
    });
  }

  // ── IIIF Image Operations ──────────────────────────────────────

  /**
   * Fast-path image info: fetch info.json for a known IIIF ID (1 request).
   * Returns pixel dimensions, IIIF URLs for thumbnail and full resolution.
   */
  async getImageInfoFast(iiifId: string, thumbnailWidth: number = 800): Promise<ArtworkImageInfo | null> {
    try {
      return await this.buildImageInfo(iiifId, thumbnailWidth);
    } catch (err) {
      console.error("Fast image info failed:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** Shared info.json fetch + URL construction. */
  private async buildImageInfo(iiifId: string, thumbnailWidth: number): Promise<ArtworkImageInfo> {
    const iiifInfoUrl = `${RijksmuseumApiClient.IIIF_BASE}/${iiifId}/info.json`;
    const info = await this.cache.getOrFetch<IIIFInfoResponse>(
      `iiif:${iiifId}`,
      async () => (await this.http.get<IIIFInfoResponse>(iiifInfoUrl)).data,
      RijksmuseumApiClient.TTL_IMAGE
    );

    // Constrain the longest edge: w, for landscape; ,h for portrait
    // (iiif.micr.io's !w,h best-fit syntax is broken — forces exact w×h)
    const sizeParam = info.width >= info.height
      ? `${thumbnailWidth},`
      : `,${thumbnailWidth}`;

    return {
      iiifId,
      iiifInfoUrl,
      thumbnailUrl: `${RijksmuseumApiClient.IIIF_BASE}/${iiifId}/full/${sizeParam}/0/default.jpg`,
      fullUrl: `${RijksmuseumApiClient.IIIF_BASE}/${iiifId}/full/max/0/default.jpg`,
      width: info.width,
      height: info.height,
    };
  }

  /** Fetch a IIIF image URL as base64 (shared by region and thumbnail fetchers) */
  private async fetchIiifAsBase64(url: string): Promise<{ data: string; mimeType: string }> {
    try {
      const { data } = await this.http.get(url, {
        responseType: "arraybuffer",
        headers: { Accept: "image/jpeg, image/*" },
      });
      return { data: Buffer.from(data).toString("base64"), mimeType: "image/jpeg" };
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        if (status === 400) throw new Error("IIIF request rejected (HTTP 400) — likely an invalid region or size exceeding image dimensions");
        if (status === 429) throw new Error("IIIF server rate limited — wait a moment and retry");
        if (status === 404) throw new Error("Image not available from IIIF server");
        if (status && status >= 500) throw new Error(`IIIF server error (HTTP ${status})`);
        if (err.code === "ECONNABORTED") throw new Error("IIIF request timed out");
      }
      throw err;
    }
  }

  /** Fetch a IIIF region (or full image) as base64 for direct LLM visual analysis */
  async fetchRegionBase64(
    iiifId: string,
    region: string = "full",
    size: number = 1200,
    rotation: number = 0,
    quality: "default" | "gray" = "default",
  ): Promise<{ data: string; mimeType: string }> {
    const url = `${RijksmuseumApiClient.IIIF_BASE}/${iiifId}/${region}/${size},/${rotation}/${quality}.jpg`;

    // Cache full-image fetches (most commonly repeated in exploration sessions).
    // Cropped regions vary too much to cache effectively.
    if (region === "full") {
      const cacheKey = `img:${iiifId}:${size}:${rotation}:${quality}`;
      return this.imageCache.getOrFetch(cacheKey, () => this.fetchIiifAsBase64(url));
    }

    return this.fetchIiifAsBase64(url);
  }
}
