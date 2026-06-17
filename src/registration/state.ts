// ─── Shared IIIF region validation ───────────────────────────────────

export const IIIF_REGION_RE = /^(full|square|\d+,\d+,\d+,\d+|pct:[0-9.]+,[0-9.]+,[0-9.]+,[0-9.]+|crop_pixels:\d+,\d+,\d+,\d+)$/;

// ─── Viewer command queue (module-scoped — survives across HTTP requests) ─

import fs from "node:fs";
import { ResponseCache } from "../utils/ResponseCache.js";
import { type CollectionStatsResult } from "../api/VocabularyDb.js";
import { type TextBlock } from "../utils/responseShape.js";

// Shared with geometry.ts (CropLocalSize defined here because ViewerCommand references it
// before the geometry section — geometry.ts imports it from here).
export interface CropLocalSize {
  width: number;
  height: number;
}

interface ViewerCommand {
  action: "navigate" | "add_overlay" | "clear_overlays";
  region?: string;
  relativeTo?: string;
  relativeToSize?: CropLocalSize;
  label?: string;
  color?: string;
}
export interface OverlayEntry {
  label?: string;
  region: string;
  color?: string;
}
export interface ViewerQueue {
  commands: ViewerCommand[];
  createdAt: number;
  lastAccess: number;
  lastPolledAt?: number;
  objectNumber: string;
  imageWidth?: number;
  imageHeight?: number;
  activeOverlays: OverlayEntry[];
}
/** Start a 60s interval that deletes entries older than `ttlMs` from a Map. */
export function sweepTtlMap<T extends { lastAccess: number }>(map: Map<string, T>, ttlMs = 1_800_000): void {
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of map) {
      if (now - entry.lastAccess > ttlMs) map.delete(id);
    }
  }, 60_000).unref();
}

export const viewerQueues = new Map<string, ViewerQueue>();
sweepTtlMap(viewerQueues);

export const ACTIVE_OVERLAYS_CAP = 64;

export const similarPages = new Map<string, { html: string; lastAccess: number }>();
sweepTtlMap(similarPages);

export const enrichmentReviewPages = new Map<string, { html: string; lastAccess: number }>();
sweepTtlMap(enrichmentReviewPages);

// #378 Step 4: module-scope result caches (must survive the per-request server rebuild in
// HTTP mode, like viewerQueues). Keyed on DB build-id so a deploy/DB-swap can't serve stale
// aggregates. collection_stats is synchronous (better-sqlite3 blocks the loop) so a plain
// cache already coalesces identical concurrent calls; semantic_search awaits embed() before
// its sync vec0 scan, so it also needs in-flight de-dup to stop two identical queries each
// paying the ~1s scan.
type ToolResponse = { content: TextBlock[] };
type StructuredToolResponse = ToolResponse & { structuredContent: Record<string, unknown> };

const CACHE_TTL_MS = 1_800_000; // 30 min
export const collectionStatsCache = new ResponseCache<CollectionStatsResult>(300, CACHE_TTL_MS);
export const semanticSearchCache = new ResponseCache<ToolResponse | StructuredToolResponse>(500, CACHE_TTL_MS);
export const semanticInflight = new Map<string, Promise<ToolResponse | StructuredToolResponse>>();

/** Stdio-mode temp files for find_similar. Swept on same 30-min TTL. */
export const similarTempFiles = new Map<string, number>(); // path → createdAt
setInterval(() => {
  const now = Date.now();
  for (const [filePath, createdAt] of similarTempFiles) {
    if (now - createdAt > 1_800_000) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          console.warn(`[similar-sweeper] failed to unlink ${filePath}:`, err);
        }
      }
      similarTempFiles.delete(filePath);
    }
  }
}, 60_000).unref();
