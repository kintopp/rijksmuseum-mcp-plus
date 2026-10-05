// ─── Shared IIIF region validation ───────────────────────────────────

export const IIIF_REGION_RE = /^(full|square|\d+,\d+,\d+,\d+|pct:[0-9.]+,[0-9.]+,[0-9.]+,[0-9.]+|crop_pixels:\d+,\d+,\d+,\d+)$/;

// ─── Viewer command queue (module-scoped — survives across HTTP requests) ─

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResponseCache } from "../utils/ResponseCache.js";
import { logWarn } from "../utils/log.js";
import { type CollectionStatsResult } from "../api/VocabularyDb.js";
import { type TextBlock } from "../utils/responseShape.js";

// Shared with geometry.ts (CropLocalSize defined here because ViewerCommand references it
// before the geometry section — geometry.ts imports it from here).
export interface CropLocalSize {
  width: number;
  height: number;
}

// The viewer command channel carries region zoom/pan only. relativeTo/relativeToSize
// are transient input fields projected to full-image space and stripped before the
// command is queued; the iframe only ever sees { action: "navigate", region }.
interface ViewerCommand {
  action: "navigate";
  region?: string;
  relativeTo?: string;
  relativeToSize?: CropLocalSize;
}
export interface ViewerQueue {
  commands: ViewerCommand[];
  createdAt: number;
  lastAccess: number;
  lastPolledAt?: number;
  objectNumber: string;
  imageWidth?: number;
  imageHeight?: number;
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

// Generated HTML pages served at /similar/:uuid and /enrichment-review/:uuid. Capped because
// pages run to hundreds of KB and any public caller can mint them; the route re-sets on each
// view so the 30-min TTL slides with use.
const HTML_PAGE_CAP = 100;
const HTML_PAGE_TTL_MS = 1_800_000;
export const similarPages = new ResponseCache<string>(HTML_PAGE_CAP, HTML_PAGE_TTL_MS);
export const enrichmentReviewPages = new ResponseCache<string>(HTML_PAGE_CAP, HTML_PAGE_TTL_MS);

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

/** Stdio-mode temp HTML files (find_similar, enrichment review). Swept on same 30-min TTL. */
const tempPageFiles = new Map<string, number>(); // path → createdAt

/** Write a stdio-mode HTML page to the OS temp dir and register it for the sweep; returns the path. */
export function writeTempPage(prefix: string, id: string, html: string): string {
  const filePath = path.join(os.tmpdir(), `${prefix}-${id}.html`);
  fs.writeFileSync(filePath, html, "utf-8");
  tempPageFiles.set(filePath, Date.now());
  return filePath;
}

setInterval(() => {
  const now = Date.now();
  for (const [filePath, createdAt] of tempPageFiles) {
    if (now - createdAt > 1_800_000) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          logWarn(`[temp-page-sweeper] failed to unlink ${filePath}`, err);
        }
      }
      tempPageFiles.delete(filePath);
    }
  }
}, 60_000).unref();
