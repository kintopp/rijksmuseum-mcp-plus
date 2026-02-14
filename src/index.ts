#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";

import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import { RijksmuseumApiClient } from "./api/RijksmuseumApiClient.js";
import { OaiPmhClient } from "./api/OaiPmhClient.js";
import { VocabularyDb } from "./api/VocabularyDb.js";
import { registerAll } from "./registration.js";
import { getViewerHtml } from "./viewer.js";

const SERVER_NAME = "rijksmuseum-mcp+";
const SERVER_VERSION = "2.0.0";

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
  if (fs.existsSync(dbPath)) return;

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

// ─── Create a configured McpServer ───────────────────────────────────

function createServer(httpPort?: number): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions:
        "Rijksmuseum MCP server — search the collection, get artwork details, " +
        "view high-resolution IIIF images, and explore artist timelines. " +
        "No API key required.",
    }
  );

  const apiClient = new RijksmuseumApiClient();
  const oaiClient = new OaiPmhClient();
  registerAll(server, apiClient, oaiClient, vocabDb, httpPort);
  return server;
}

// ─── Stdio mode ──────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  await initVocabularyDb();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Rijksmuseum MCP server running on stdio");
}

// ─── HTTP mode ───────────────────────────────────────────────────────

async function runHttp(): Promise<void> {
  await initVocabularyDb();
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
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  // ── Start ───────────────────────────────────────────────────────

  httpServer = app.listen(port, () => {
    console.error(`Rijksmuseum MCP server listening on http://localhost:${port}`);
    console.error(`  MCP endpoint: POST /mcp`);
    console.error(`  Viewer:       GET  /viewer?iiif={id}&title={title}`);
    console.error(`  Health:       GET  /health`);
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
