#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { RijksmuseumApiClient } from "./api/RijksmuseumApiClient.js";
import { OaiPmhClient } from "./api/OaiPmhClient.js";
import { VocabularyDb } from "./api/VocabularyDb.js";
import { IconclassDb } from "./api/IconclassDb.js";
import { EmbeddingsDb } from "./api/EmbeddingsDb.js";
import { EmbeddingModel } from "./api/EmbeddingModel.js";
import { ResponseCache } from "./utils/ResponseCache.js";
import { UsageStats } from "./utils/UsageStats.js";
import { TOP_100_SET } from "./types.js";
import { registerAll } from "./registration.js";
import { getViewerHtml } from "./viewer.js";
import { StubOAuthProvider } from "./auth/StubOAuthProvider.js";

const SERVER_NAME = "rijksmuseum-mcp+";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
const SERVER_VERSION: string = pkg.version;

function getGitCommit(): string {
  // Railway injects this automatically
  if (process.env.RAILWAY_GIT_COMMIT_SHA) {
    return process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7);
  }
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

const ICONCLASS_DB_SPEC: DbSpec = {
  name: "Iconclass",
  pathEnvVar: "ICONCLASS_DB_PATH",
  urlEnvVar: "ICONCLASS_DB_URL",
  defaultFile: "iconclass.db",
  validationQuery: "SELECT 1 FROM notations LIMIT 1",
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
  const downloadTimer = setTimeout(() => controller.abort(), 300_000);
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
let iconclassDb: IconclassDb | null = null;
let embeddingsDb: EmbeddingsDb | null = null;
let embeddingModel: EmbeddingModel | null = null;

async function initDatabases(): Promise<void> {
  await ensureDb(VOCAB_DB_SPEC);
  vocabDb = new VocabularyDb();
  await ensureDb(ICONCLASS_DB_SPEC);
  iconclassDb = new IconclassDb();
  await ensureDb(EMBEDDINGS_DB_SPEC);
  embeddingsDb = new EmbeddingsDb();
  if (embeddingsDb.available) {
    embeddingModel = new EmbeddingModel();
    const modelId = process.env.EMBEDDING_MODEL_ID ?? "Xenova/multilingual-e5-small";
    await embeddingModel.init(modelId, embeddingsDb.vectorDimensions);
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

// ─── Pre-warm caches ─────────────────────────────────────────────────

// Structural/administrative AAT terms the Rijksmuseum resolver doesn't serve (404).
// Excluded from pre-warming to avoid wasted HTTP requests on every startup.
const UNRESOLVABLE_IDS = new Set([
  "300404450", // primary
  "300379012", // undetermined
  "300404451", // secondary
  "300078817", // rectos
  "300010292", // versos
]);

/** Pre-warm the top 200 vocabulary terms by frequency in the collection. */
async function warmVocabCache(): Promise<void> {
  if (!vocabDb?.available) return;

  // Fetch 205 to get 200 after filtering 5 unresolvable terms
  const uris = vocabDb.topTermUris(205).filter(
    (uri) => !UNRESOLVABLE_IDS.has(uri.split("/").pop()!)
  );
  if (uris.length === 0) return;

  const start = performance.now();
  const resolved = await sharedApiClient.warmVocabCache(uris);
  const ms = Math.round(performance.now() - start);
  console.error(`Vocab cache pre-warmed: ${resolved}/${uris.length} terms in ${ms}ms`);
}

/**
 * Pre-warm vocabulary terms referenced by the museum's Top 100 artworks.
 * Resolves each artwork's Linked Art object, then resolves all vocabulary
 * URIs found (types, materials, techniques, places, subjects). The vocab
 * terms are cached at 1-hour TTL; the artwork objects themselves expire
 * after 5 minutes but that's fine — the value is in the vocab terms.
 */
async function warmTopArtworkVocab(): Promise<void> {
  try {
    const lodUris = await collectSetLodUris(TOP_100_SET);
    if (lodUris.length === 0) return;

    // Resolve objects and their vocab terms in batches of 10
    let vocabCount = 0;
    for (let i = 0; i < lodUris.length; i += 10) {
      const batch = lodUris.slice(i, i + 10);
      const objects = await Promise.allSettled(
        batch.map((uri) => sharedApiClient.resolveObject(uri))
      );
      const resolved = objects
        .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
        .map((r) => r.value);
      const vocabResults = await Promise.all(
        resolved.map((obj) => sharedApiClient.resolveVocabulary(obj).catch(() => null))
      );
      vocabCount += vocabResults.filter(Boolean).length;
    }

    console.error(`Top artwork vocab pre-warmed: ${vocabCount}/${lodUris.length} artworks`);
  } catch (err) {
    console.error(`Top artwork vocab pre-warm failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Paginate through an OAI-PMH set and collect all Linked Art URIs. */
async function collectSetLodUris(setSpec: string): Promise<string[]> {
  const uris: string[] = [];
  let result = await sharedOaiClient.listRecords({ set: setSpec });
  while (true) {
    for (const rec of result.records) {
      if (rec.lodUri) uris.push(rec.lodUri);
    }
    if (!result.resumptionToken) break;
    result = await sharedOaiClient.listRecords({ resumptionToken: result.resumptionToken });
  }
  return uris;
}

// ─── Create a configured McpServer ───────────────────────────────────

function createServer(httpPort?: number): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "Rijksmuseum MCP+" },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions:
        "Rijksmuseum collection explorer — circa 830,000 artworks from antiquity to the present day " +
        "spanning paintings, prints, drawings, photographs, furniture, ceramics, textiles, and more.\n\n" +

        "Search combines two backends: a title-based Search API and a vocabulary database with structured filters " +
        "(subject, material, technique, creator, depicted persons/places, Iconclass notation, dates, dimensions, and more). " +
        "Vocabulary filters combine freely with each other; imageAvailable and aboutActor use a separate search path " +
        "and cannot be mixed with them. Results are returned in cataloguing order, not ranked by relevance. " +
        "Use search_artwork for discovery, get_artwork_details for full metadata on a specific work.\n\n" +

        "Images are served via IIIF deep-zoom. For this purpose, get_artwork_image opens an interactive viewer — " +
        "it does not return the image bytes. To get the actual image into the conversation for visual analysis, " +
        "use the analyse-artwork prompt, which fetches it server-side as base64.\n\n" +

        "Person names are matched against 210K name variants (76K persons) using phrase matching with fallback " +
        "to token intersection — partial names and historical variants often work. " +
        "When depictedPerson returns no results, the server automatically retries via aboutActor (Search API) for broader matching.\n\n" +

        "Place searches support proximity (nearPlace), depicted places, and production places. " +
        "64% of places are geocoded. Multi-word queries like 'Oude Kerk Amsterdam' are resolved " +
        "via progressive token splitting with geo-disambiguation.\n\n" +

        "Iconclass covers 40,675 subject notations. Use lookup_iconclass to find notation codes by concept, " +
        "then pass them to search_artwork for precise iconographic filtering.\n\n" +

        "Descriptions (Dutch, cataloguer-written) cover 61% of artworks. " +
        "Curatorial narratives (English, interpretive wall text) cover ~14K works. " +
        "Both are searchable but use exact word matching — no stemming.\n\n" +

        "For concept and theme searches where exact vocabulary terms are unknown, use semantic_search — " +
        "it ranks artworks by embedding similarity to a free-text query. " +
        "Use search_artwork when the query names a specific artist, place, date, material, or Iconclass term. " +
        "Use semantic_search when the concept cannot be expressed as a subject tag or notation " +
        "(atmosphere, emotion, composition, art-historical interpretation), or when search_artwork returned zero results. " +
        "For queries where paintings are the expected result type, always combine semantic_search with " +
        "a follow-up search_artwork(type: 'painting', subject: ...) or search_artwork(type: 'painting', creator: ...) — " +
        "paintings are underrepresented in semantic results and the absence of key works is not visible in the output. " +
        "Do not use technique: 'painting' to filter to paintings — use type: 'painting' instead.",
    }
  );

  registerAll(server, sharedApiClient, sharedOaiClient, vocabDb, iconclassDb, embeddingsDb, embeddingModel, httpPort, usageStats);
  return server;
}

// ─── Stdio mode ──────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  await initDatabases();
  initSharedClients();
  initUsageStats();
  const server = createServer();
  // Pre-warm HTTP caches in background (non-blocking)
  warmVocabCache().then(() => warmTopArtworkVocab());
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

  const allowedOrigins = process.env.ALLOWED_ORIGINS;
  app.use(
    cors({
      origin: allowedOrigins ? allowedOrigins.split(",") : "*",
    })
  );
  app.use(express.json());

  // ── Stub OAuth endpoints (Claude mobile/desktop compatibility) ──
  //
  // Claude clients perform RFC 8414/9728 OAuth discovery before connecting.
  // Without valid endpoints they show confusing auth errors even though
  // this server is fully public. The stub issues tokens but /mcp never
  // checks them.

  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
  app.use(mcpAuthRouter({
    provider: new StubOAuthProvider(),
    issuerUrl: new URL(publicUrl),
    serviceDocumentationUrl: new URL("https://github.com/kintopp/rijksmuseum-mcp-plus"),
    resourceServerUrl: new URL(`${publicUrl}/mcp`),
  }));

  // ── MCP endpoint (stateless — no sessions, no SSE streams) ─────
  //
  // Each POST creates a fresh transport+server, processes the request,
  // and responds. No long-lived connections to time out (#41).

  app.post("/mcp", async (req: express.Request, res: express.Response) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = createServer(port);
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

  // ── Viewer endpoint ─────────────────────────────────────────────

  app.get("/viewer", (req: express.Request, res: express.Response) => {
    const iiifId = req.query.iiif as string;
    const title = (req.query.title as string) || "Artwork";

    if (!iiifId) {
      res.status(400).json({ error: "Missing ?iiif= parameter" });
      return;
    }

    try {
      res.type("html").send(getViewerHtml(iiifId, title));
    } catch {
      res.status(400).json({ error: "Invalid IIIF ID format" });
    }
  });

  // ── Health check ────────────────────────────────────────────────

  app.get("/health", (_req: express.Request, res: express.Response) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION, commit: GIT_COMMIT });
  });

  // ── Start ───────────────────────────────────────────────────────

  httpServer = app.listen(port, () => {
    console.error(`Rijksmuseum MCP server listening on http://localhost:${port}`);
    console.error(`  MCP endpoint: POST /mcp`);
    console.error(`  Viewer:       GET  /viewer?iiif={id}&title={title}`);
    console.error(`  Health:       GET  /health`);
    // Pre-warm response caches in background after server is accepting connections.
    warmVocabCache().then(() => warmTopArtworkVocab());
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
