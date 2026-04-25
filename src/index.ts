#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import compression from "compression";
import cors from "cors";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

import { RijksmuseumApiClient } from "./api/RijksmuseumApiClient.js";
import { OaiPmhClient } from "./api/OaiPmhClient.js";
import { VocabularyDb } from "./api/VocabularyDb.js";
import { EmbeddingsDb } from "./api/EmbeddingsDb.js";
import { EmbeddingModel } from "./api/EmbeddingModel.js";
import { ResponseCache } from "./utils/ResponseCache.js";
import { UsageStats } from "./utils/UsageStats.js";
import { registerAll, similarPages, enrichmentReviewPages } from "./registration.js";

const SERVER_NAME = "rijksmuseum-mcp+";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
const SERVER_VERSION: string = pkg.version;

function getGitCommit(): string {
  // Railway webhook deploys
  if (process.env.RAILWAY_GIT_COMMIT_SHA) {
    return process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7);
  }
  // `railway up` / CLI deploys — read hash baked at build time
  try {
    const commitFile = new URL("commit.txt", import.meta.url);
    return fs.readFileSync(commitFile, "utf-8").trim();
  } catch { /* no build artifact */ }
  // Local dev with git repo available
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

const GIT_COMMIT = getGitCommit();

// ─── Types ───────────────────────────────────────────────────────────

// ─── Determine transport mode ────────────────────────────────────────

function shouldUseHttp(): boolean {
  return process.argv.includes("--http") || !!process.env.PORT;
}

function getHttpPort(): number {
  return parseInt(process.env.PORT ?? "3000", 10);
}

// ─── Database download helpers (run once per volume lifetime) ────────

interface DbSpec {
  name: string;
  pathEnvVar: string;
  urlEnvVar: string;
  defaultFile: string;
  /** SQL query that must succeed for the DB to be considered valid. */
  validationQuery: string;
}

const VOCAB_DB_SPEC: DbSpec = {
  name: "Vocabulary",
  pathEnvVar: "VOCAB_DB_PATH",
  urlEnvVar: "VOCAB_DB_URL",
  defaultFile: "vocabulary.db",
  validationQuery: "SELECT 1 FROM vocab_term_counts LIMIT 1",
};

const EMBEDDINGS_DB_SPEC: DbSpec = {
  name: "Embeddings",
  pathEnvVar: "EMBEDDINGS_DB_PATH",
  urlEnvVar: "EMBEDDINGS_DB_URL",
  defaultFile: "embeddings.db",
  validationQuery: "SELECT 1 FROM artwork_embeddings LIMIT 1",
};

function resolveDbPathForSpec(spec: DbSpec): string {
  return process.env[spec.pathEnvVar] || path.join(__dirname, "..", "data", spec.defaultFile);
}

/**
 * Ensure a SQLite database exists and passes validation.
 * Downloads from the URL env var if missing or invalid.
 */
async function ensureDb(spec: DbSpec): Promise<void> {
  const dbPath = resolveDbPathForSpec(spec);

  if (fs.existsSync(dbPath)) {
    try {
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(dbPath, { readonly: true });
      db.prepare(spec.validationQuery).get();
      db.close();
      return;
    } catch {
      console.error(`${spec.name} DB invalid or outdated — will re-download`);
    }
  }

  const url = process.env[spec.urlEnvVar];
  if (!url) return;

  console.error(`Downloading ${spec.name} DB...`);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmpPath = dbPath + ".tmp";
  const controller = new AbortController();
  const downloadTimer = setTimeout(() => controller.abort(), 330_000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    const dest = fs.createWriteStream(tmpPath);
    const isGzip = url.endsWith(".gz") || res.headers.get("content-type")?.includes("gzip");

    if (isGzip) {
      await pipeline(res.body, createGunzip(), dest);
    } else {
      await pipeline(res.body, dest);
    }

    fs.renameSync(tmpPath, dbPath);
    console.error(`${spec.name} DB ready: ${dbPath}`);
  } catch (err) {
    console.error(`Failed to download ${spec.name} DB: ${err instanceof Error ? err.message : err}`);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } finally {
    clearTimeout(downloadTimer);
  }
}

// ─── Shared database instances (one read-only instance each) ─────────

let vocabDb: VocabularyDb | null = null;
let embeddingsDb: EmbeddingsDb | null = null;
let embeddingModel: EmbeddingModel | null = null;

async function initDatabases(): Promise<void> {
  await ensureDb(VOCAB_DB_SPEC);
  vocabDb = new VocabularyDb();
  await ensureDb(EMBEDDINGS_DB_SPEC);
  embeddingsDb = new EmbeddingsDb();
  const needsModel = embeddingsDb.available;
  if (needsModel) {
    embeddingModel = new EmbeddingModel();
    const modelId = process.env.EMBEDDING_MODEL_ID ?? "Xenova/multilingual-e5-small";
    const targetDim = embeddingsDb.available ? embeddingsDb.vectorDimensions : 0;
    await embeddingModel.init(modelId, targetDim);
  }
}

// ─── Shared client instances (one per process) ──────────────────────

let sharedApiClient: RijksmuseumApiClient;
let sharedOaiClient: OaiPmhClient;

function initSharedClients(): void {
  const cache = new ResponseCache(1000, 5 * 60_000);
  sharedApiClient = new RijksmuseumApiClient(cache);
  sharedOaiClient = new OaiPmhClient();
}

// ─── Usage stats accumulator ─────────────────────────────────────────

let usageStats: UsageStats | undefined;

function initUsageStats(): void {
  usageStats = new UsageStats();
}

// ─── Create a configured McpServer ───────────────────────────────────

function createServer(httpPort?: number): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "Rijksmuseum MCP+" },
    {
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
      instructions:
        "Rijksmuseum collection explorer — circa 830,000 artworks from antiquity to the present day " +
        "spanning paintings, prints, drawings, photographs, furniture, ceramics, textiles, and more.\n\n" +

        "Search uses a vocabulary database with structured filters " +
        "(subject, material, technique, creator, depicted persons/places, Iconclass notation, dates, dimensions, and more). " +
        "All filters combine freely with each other. Results are ranked by BM25 relevance when text search is used, " +
        "by geographic proximity for nearPlace, and by importance (image availability, curatorial attention) otherwise. " +
        "Use search_artwork for discovery, get_artwork_details for full metadata on a specific work.\n\n" +

        "Images are served via IIIF deep-zoom. get_artwork_image opens an interactive viewer (metadata + viewer link, no image bytes). " +
        "To get actual image bytes for visual analysis, use inspect_artwork_image — it returns base64 image data that the LLM can see directly. " +
        "Call it with region 'full' for the complete artwork, or 'pct:x,y,w,h' to zoom into a specific area. " +
        "After analyzing a crop, you can call navigate_viewer with the same region to zoom the viewer for the user. " +
        "For overlay placement, always inspect before overlaying: full image first to understand layout, " +
        "then close-up crops to verify target positions. Coordinates use full-image space — the same " +
        "pct:x,y,w,h works identically in both inspect_artwork_image and navigate_viewer.\n\n" +

        "Person names are matched against 210K name variants (76K persons) using phrase matching with fallback " +
        "to token intersection — partial names and historical variants often work. " +
        "aboutActor searches both subject and creator vocabulary for broader person matching.\n\n" +

        "Place searches support proximity (nearPlace), depicted places, and production places. " +
        "64% of places are geocoded. Multi-word queries like 'Oude Kerk Amsterdam' are resolved " +
        "via progressive token splitting with geo-disambiguation.\n\n" +

        "Iconclass covers 40,675 subject notations. Use the Iconclass server's search tool to find notation codes by concept, " +
        "then pass them to search_artwork for precise iconographic filtering.\n\n" +

        "Descriptions (Dutch, cataloguer-written) cover 61% of artworks. " +
        "Curatorial narratives (English, interpretive wall text) cover ~14K works. " +
        "Both are searchable but use exact word matching — no stemming.\n\n" +

        "For concept and theme searches where exact vocabulary terms are unknown, use semantic_search — " +
        "it ranks artworks by embedding similarity to a free-text query. " +
        "Use search_artwork when the query names a specific artist, place, date, material, or Iconclass term. " +
        "Use semantic_search when the concept cannot be expressed as structured metadata " +
        "(atmosphere, emotion, composition, art-historical interpretation), or when search_artwork returned zero results. " +
        "For queries where paintings are the expected result type, always combine semantic_search with " +
        "a follow-up search_artwork(type: 'painting', subject: ...) or search_artwork(type: 'painting', creator: ...) — " +
        "paintings are underrepresented in semantic results and the absence of key works is not visible in the output. " +
        "Do not use technique: 'painting' to filter to paintings — use type: 'painting' instead.",
    }
  );

  registerAll(server, sharedApiClient, sharedOaiClient, vocabDb, embeddingsDb, embeddingModel, httpPort, usageStats);
  return server;
}

// ─── Stdio mode ──────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  await initDatabases();
  initSharedClients();
  initUsageStats();
  const server = createServer();
  if (vocabDb?.available) { vocabDb.warmCorePages(); vocabDb.warmSimilarCaches(); }
  if (embeddingsDb?.available) embeddingsDb.warmCorePages();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Rijksmuseum MCP server running on stdio");
}

// ─── HTTP mode ───────────────────────────────────────────────────────

async function runHttp(): Promise<void> {
  await initDatabases();
  initSharedClients();
  initUsageStats();
  const port = getHttpPort();
  const app = express();
  app.set("trust proxy", 1); // Railway reverse proxy sets X-Forwarded-For

  const allowedOrigins = process.env.ALLOWED_ORIGINS;
  app.use(
    cors({
      origin: allowedOrigins ? allowedOrigins.split(",") : "*",
    })
  );
  app.use(compression({ threshold: 1024 })); // gzip responses ≥ 1 KB (skips small payloads + base64 images)
  app.use(express.json());

  // ── MCP endpoint (stateless — no sessions, no SSE streams) ─────
  //
  // The McpServer (with all registered tools/resources/prompts) is created
  // once and reused across requests. Only the transport is per-request.
  // Protocol.connect() requires _transport to be unset, which transport.close()
  // ensures via the _onclose callback. No long-lived connections to time out (#41).

  const server = createServer(port);

  // 30s safety net — respond 504 before Railway's proxy kills the connection silently
  app.use("/mcp", (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setTimeout(30_000, () => {
      if (!res.headersSent) {
        res.status(504).json({ error: "Request timeout" });
      }
    });
    next();
  });

  app.post("/mcp", async (req: express.Request, res: express.Response) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      await transport.close();
    } catch (err) {
      console.error("MCP endpoint error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  // Reject GET/DELETE/etc. — stateless mode has no SSE streams or sessions
  app.all("/mcp", (_req: express.Request, res: express.Response) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed — this server is stateless (POST only)" });
  });

  // ── Similar artworks comparison page ────────────────────────────

  app.get("/similar/:uuid", (req: express.Request, res: express.Response) => {
    const page = similarPages.get(req.params.uuid as string);
    if (!page) {
      res.status(404).json({ error: "Page not found or expired (30 min TTL)" });
      return;
    }
    page.lastAccess = Date.now();
    res.type("html").send(page.html);
  });

  app.get("/enrichment-review/:uuid", (req: express.Request, res: express.Response) => {
    const page = enrichmentReviewPages.get(req.params.uuid as string);
    if (!page) {
      res.status(404).json({ error: "Page not found or expired (30 min TTL)" });
      return;
    }
    page.lastAccess = Date.now();
    res.type("html").send(page.html);
  });

  // ── Warm DB pages before accepting traffic ─────────────────────
  //
  // Page in critical mmap regions so the first real user query is fast.
  // This runs before app.listen(), so Railway's healthcheck only passes
  // once the DBs are warm.

  if (vocabDb?.available) { vocabDb.warmCorePages(); vocabDb.warmSimilarCaches(); }
  if (embeddingsDb?.available) embeddingsDb.warmCorePages();

  // ── Health + readiness ──────────────────────────────────────────
  //
  // /health is the Railway liveness probe — passes as soon as express is
  // listening (DB core pages already warmed above).
  // /ready is an informational readiness flag: flips true once the ONNX
  // embedding model has done one inference and the filtered-KNN path is
  // warm. Railway is NOT configured to gate on /ready — the flag is purely
  // for observability so cold-path spikes are attributable.

  let ready = false;

  app.get("/health", (_req: express.Request, res: express.Response) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION, commit: GIT_COMMIT });
  });

  app.get("/ready", (_req: express.Request, res: express.Response) => {
    res.json({ ready, status: ready ? "warm" : "warming" });
  });

  // ── Start ───────────────────────────────────────────────────────

  httpServer = app.listen(port, () => {
    console.error(`Rijksmuseum MCP server listening on http://localhost:${port}`);
    console.error(`  MCP endpoint: POST /mcp`);
    console.error(`  Health:       GET  /health`);
    console.error(`  Ready:        GET  /ready`);

    // Post-listen warm-up — healthcheck already passes, so this doesn't delay
    // deployment. Covers the ONNX first-inference cost + filtered-KNN page
    // faults that warmCorePages() doesn't touch.
    void (async () => {
      const t0 = Date.now();
      try {
        let warmVec: Float32Array | undefined;
        if (embeddingModel?.available) {
          warmVec = await embeddingModel.embed("warmup");
          console.error(`  Embedding model first-inference warmed in ${Date.now() - t0}ms`);
        }
        if (embeddingsDb?.available) {
          const vec = warmVec ?? new Float32Array(embeddingsDb.vectorDimensions);
          embeddingsDb.warmFilteredPath(vec);
        }
        ready = true;
        console.error(`  Post-listen warmup complete in ${Date.now() - t0}ms — /ready now true`);
      } catch (err) {
        console.error(`  Post-listen warmup failed: ${err instanceof Error ? err.message : err}`);
        ready = true; // don't leave /ready stuck — failure is logged
      }
    })();
  });
}


// ─── Graceful shutdown ───────────────────────────────────────────────

let httpServer: import("node:http").Server | undefined;

function shutdown() {
  console.error("Shutting down...");
  usageStats?.flush();
  httpServer?.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── Entry point ─────────────────────────────────────────────────────

if (shouldUseHttp()) {
  runHttp().catch((err) => {
    console.error("Failed to start HTTP server:", err);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    console.error("Failed to start stdio server:", err);
    process.exit(1);
  });
}
