#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";

import { RijksmuseumApiClient } from "./api/RijksmuseumApiClient.js";
import { registerAll } from "./registration.js";
import { getViewerHtml } from "./viewer.js";

const SERVER_NAME = "rijksmuseum-mcp+";
const SERVER_VERSION = "2.0.0";

// ─── Determine transport mode ────────────────────────────────────────

function shouldUseHttp(): boolean {
  return process.argv.includes("--http") || !!process.env.PORT;
}

function getHttpPort(): number {
  return parseInt(process.env.PORT ?? "3000", 10);
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
  registerAll(server, apiClient, httpPort);
  return server;
}

// ─── Stdio mode ──────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Rijksmuseum MCP server running on stdio");
}

// ─── HTTP mode ───────────────────────────────────────────────────────

async function runHttp(): Promise<void> {
  const port = getHttpPort();
  const app = express();

  const allowedOrigins = process.env.ALLOWED_ORIGINS;
  app.use(
    cors({
      origin: allowedOrigins ? allowedOrigins.split(",") : "*",
    })
  );
  app.use(express.json());

  // Track active sessions
  const sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >();

  // ── MCP endpoint ────────────────────────────────────────────────

  app.all("/mcp", async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "GET" || req.method === "DELETE") {
      // GET = SSE stream, DELETE = close session
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({ error: "Invalid or missing session ID" });
        return;
      }
      const session = sessions.get(sessionId)!;

      if (req.method === "DELETE") {
        await session.transport.handleRequest(req, res);
        sessions.delete(sessionId);
        return;
      }

      await session.transport.handleRequest(req, res);
      return;
    }

    // POST — could be a new session (initialize) or existing session message
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    const server = createServer(port);
    registerCleanup(transport, sessions);

    await server.connect(transport);

    // Store session after connection (transport now has a sessionId)
    const newSessionId = transport.sessionId;
    if (newSessionId) {
      sessions.set(newSessionId, { server, transport });
    }

    await transport.handleRequest(req, res, req.body);
  });

  // ── Viewer endpoint ─────────────────────────────────────────────

  app.get("/viewer", (req: express.Request, res: express.Response) => {
    const iiifId = req.query.iiif as string;
    const title = (req.query.title as string) || "Artwork";

    if (!iiifId) {
      res.status(400).json({ error: "Missing ?iiif= parameter" });
      return;
    }

    res.type("html").send(getViewerHtml(iiifId, title));
  });

  // ── Health check ────────────────────────────────────────────────

  app.get("/health", (_req: express.Request, res: express.Response) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  // ── Start ───────────────────────────────────────────────────────

  app.listen(port, () => {
    console.error(`Rijksmuseum MCP server listening on http://localhost:${port}`);
    console.error(`  MCP endpoint: POST /mcp`);
    console.error(`  Viewer:       GET  /viewer?iiif={id}&title={title}`);
    console.error(`  Health:       GET  /health`);
  });
}

/** Clean up session when transport closes */
function registerCleanup(
  transport: StreamableHTTPServerTransport,
  sessions: Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>
): void {
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) sessions.delete(sid);
  };
}

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
