#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

import { RijksmuseumApiClient } from "./api/RijksmuseumApiClient.js";
import { OaiPmhClient } from "./api/OaiPmhClient.js";
import { VocabularyDb } from "./api/VocabularyDb.js";
import { ResponseCache } from "./utils/ResponseCache.js";
import { UsageStats } from "./utils/UsageStats.js";
import { registerAll } from "./registration.js";
import { getViewerHtml } from "./viewer.js";

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

type SessionData = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
};

// ─── Determine transport mode ────────────────────────────────────────

function shouldUseHttp(): boolean {
  return process.argv.includes("--http") || !!process.env.PORT;
}

function getHttpPort(): number {
  return parseInt(process.env.PORT ?? "3000", 10);
}

// ─── Vocabulary DB download (runs once per volume lifetime) ─────────

function resolveDbPath(): string {
  return process.env.VOCAB_DB_PATH || path.join(process.cwd(), "data", "vocabulary.db");
}

async function ensureVocabularyDb(): Promise<void> {
  const dbPath = resolveDbPath();
  if (fs.existsSync(dbPath)) {
    // Check if DB has required vocab_term_counts table; if not, re-download
    try {
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(dbPath, { readonly: true });
      db.prepare("SELECT 1 FROM vocab_term_counts LIMIT 1").get();
      db.close();
      return; // DB is up to date
    } catch {
      console.error("Vocabulary DB outdated (missing vocab_term_counts) — will re-download");
      // Don't delete yet — keep the old DB as fallback until download succeeds
    }
  }

  const url = process.env.VOCAB_DB_URL;
  if (!url) return;

  console.error("Downloading vocabulary DB...");
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
    console.error(`Vocabulary DB ready: ${dbPath}`);
  } catch (err) {
    console.error(`Failed to download vocabulary DB: ${err instanceof Error ? err.message : err}`);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } finally {
    clearTimeout(downloadTimer);
  }
}

// ─── Shared vocabulary database (one read-only instance) ────────────

let vocabDb: VocabularyDb | null = null;

async function initVocabularyDb(): Promise<void> {
  await ensureVocabularyDb();
  vocabDb = new VocabularyDb();
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

/** Pre-warm the top 200 vocabulary terms by frequency in the collection. */
async function warmVocabCache(): Promise<void> {
  if (!vocabDb?.available) return;

  const uris = vocabDb.topTermUris(200);
  if (uris.length === 0) return;

  const start = performance.now();
  const resolved = await sharedApiClient.warmVocabCache(uris);
  const ms = Math.round(performance.now() - start);
  console.error(`Vocab cache pre-warmed: ${resolved}/${uris.length} terms in ${ms}ms`);
}

/** The museum's "Top 100" curated set — their highlight selection. */
const TOP_100_SET = "260213";

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
        "Rijksmuseum MCP server — search the collection, get artwork details, " +
        "view high-resolution IIIF images, and explore artist timelines. " +
        "No API key required.",
    }
  );

  registerAll(server, sharedApiClient, sharedOaiClient, vocabDb, httpPort, usageStats);
  return server;
}

// ─── Stdio mode ──────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  await initVocabularyDb();
  vocabDb?.warmPageCache();
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
  await initVocabularyDb();
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

  // Track active sessions (with last-activity timestamp for TTL cleanup)
  const MAX_SESSIONS = 100;
  const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

  const sessions = new Map<string, SessionData>();

  // Periodically purge stale sessions
  const cleanupInterval = setInterval(() => {
    purgeStaleSessionsFrom(sessions, SESSION_TTL_MS);
  }, 60_000);
  cleanupInterval.unref(); // Don't prevent process exit

  // ── MCP endpoint ────────────────────────────────────────────────

  app.all("/mcp", async (req: express.Request, res: express.Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // Handle GET (SSE stream) or DELETE (close session)
      if (req.method === "GET" || req.method === "DELETE") {
        if (!sessionId || !sessions.has(sessionId)) {
          res.status(400).json({ error: "Invalid or missing session ID" });
          return;
        }

        const session = sessions.get(sessionId)!;
        session.lastActivity = Date.now();
        await session.transport.handleRequest(req, res);

        if (req.method === "DELETE") {
          sessions.delete(sessionId);
        }
        return;
      }

      // POST to existing session
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.lastActivity = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      // POST to create new session — enforce limit
      if (sessions.size >= MAX_SESSIONS) {
        res.status(503).json({ error: "Too many active sessions" });
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });

      const server = createServer(port);
      registerCleanup(transport, sessions);

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      // Store session after handleRequest (sessionId is assigned during initialize)
      const newSessionId = transport.sessionId;
      if (newSessionId) {
        sessions.set(newSessionId, { server, transport, lastActivity: Date.now() });
      }
    } catch (err) {
      console.error("MCP endpoint error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
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
    // Pre-warm caches in background after server is accepting connections.
    // setTimeout yields to the event loop so /health can respond first,
    // then warmPageCache (synchronous, ~10-80s) runs before async warming.
    setTimeout(() => {
      vocabDb?.warmPageCache();
      warmVocabCache().then(() => warmTopArtworkVocab());
    }, 0);
  });
}

function purgeStaleSessionsFrom(sessions: Map<string, SessionData>, ttlMs: number): void {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (now - session.lastActivity > ttlMs) {
      session.transport.close?.();
      sessions.delete(sid);
    }
  }
}

function registerCleanup(
  transport: StreamableHTTPServerTransport,
  sessions: Map<string, SessionData>
): void {
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) {
      sessions.delete(sid);
    }
  };
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
