import axios, { AxiosInstance } from "axios";
import https from "node:https";
import { ResponseCache } from "../utils/ResponseCache.js";
import { USER_AGENT } from "../utils/userAgent.js";
import { ArtworkImageInfo, IIIFInfoResponse } from "../types.js";
import { logError } from "../utils/log.js";

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
      headers: { Accept: "application/ld+json", "User-Agent": USER_AGENT },
      timeout: 15_000,
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 25 }),
    });
  }

  // ── IIIF Image Operations ──────────────────────────────────────

  /**
   * Fast-path image info: fetch info.json for a known IIIF ID (1 request).
   * Returns pixel dimensions, IIIF info URL, and a thumbnail URL.
   */
  async getImageInfoFast(iiifId: string, signal?: AbortSignal, thumbnailWidth: number = 800): Promise<ArtworkImageInfo | null> {
    try {
      return await this.buildImageInfo(iiifId, thumbnailWidth, signal);
    } catch (err) {
      if (!axios.isCancel(err)) logError("Fast image info failed", err);
      return null;
    }
  }

  /** Shared info.json fetch + URL construction. */
  private async buildImageInfo(iiifId: string, thumbnailWidth: number, signal?: AbortSignal): Promise<ArtworkImageInfo> {
    // iiifId is DB-resolved (short Micrio tokens), but encode as defense-in-depth
    // against any future path where a less-sanitized id reaches these templates.
    const iiifInfoUrl = `${RijksmuseumApiClient.IIIF_BASE}/${encodeURIComponent(iiifId)}/info.json`;
    const info = await this.cache.getOrFetch<IIIFInfoResponse>(
      `iiif:${iiifId}`,
      async () => (await this.http.get<IIIFInfoResponse>(iiifInfoUrl, { signal })).data,
      RijksmuseumApiClient.TTL_IMAGE
    );

    const sizeParam = `!${thumbnailWidth},${thumbnailWidth}`;

    return {
      iiifId,
      iiifInfoUrl,
      thumbnailUrl: `${RijksmuseumApiClient.IIIF_BASE}/${encodeURIComponent(iiifId)}/full/${sizeParam}/0/default.jpg`,
      width: info.width,
      height: info.height,
    };
  }

  /** Fetch a IIIF image URL as base64 (shared by region and thumbnail fetchers) */
  private async fetchIiifAsBase64(url: string, signal?: AbortSignal): Promise<{ data: string; mimeType: string }> {
    try {
      const { data } = await this.http.get(url, {
        responseType: "arraybuffer",
        headers: { Accept: "image/jpeg, image/*" },
        signal,
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
    signal?: AbortSignal,
  ): Promise<{ data: string; mimeType: string }> {
    const url = `${RijksmuseumApiClient.IIIF_BASE}/${encodeURIComponent(iiifId)}/${region}/${size},/${rotation}/${quality}.jpg`;

    // Cache full-image fetches (most commonly repeated in exploration sessions).
    // Cropped regions vary too much to cache effectively.
    if (region === "full") {
      const cacheKey = `img:${iiifId}:${size}:${rotation}:${quality}`;
      return this.imageCache.getOrFetch(cacheKey, () => this.fetchIiifAsBase64(url, signal));
    }

    return this.fetchIiifAsBase64(url, signal);
  }
}
