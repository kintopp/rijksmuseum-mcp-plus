import type { IncomingMessage, ServerResponse } from "node:http";
import type { FetchLikeMcpHandler } from "@modelcontextprotocol/node";

type NodeMcpHandler = (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>;

/**
 * Ends a /mcp response that outlives `ms`, so a stuck call fails visibly instead
 * of being cut by the hosting proxy: a 504 if nothing is written yet, else a
 * destroyed socket, since a 2025-era SSE call commits its headers at once.
 *
 * Either way `res` closes before toNodeHandler has finished, which is what makes
 * it abort the request and tear the call down. Answering through the Response
 * instead would leave the stuck call running. Wall-clock, because SSE keep-alive
 * frames reset an idle timer. A subscriptions/listen stream is long-lived by
 * design and is not timed.
 */
export function withResponseGuard(handle: NodeMcpHandler, ms: number): NodeMcpHandler {
  return async (req, res, parsedBody) => {
    const body = parsedBody as { id?: unknown; method?: unknown } | undefined;
    if (body?.method === "subscriptions/listen") return handle(req, res, parsedBody);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const id = typeof body?.id === "string" || typeof body?.id === "number" ? body.id : null;
      const payload = JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Request timeout" }, id });
      res.writeHead(504, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    }, ms);
    res.once("close", () => clearTimeout(timer));

    try {
      await handle(req, res, parsedBody);
    } catch (err) {
      // After a 504, the adapter's unconditional writeHead throws.
      if (!timedOut || (err as NodeJS.ErrnoException).code !== "ERR_HTTP_HEADERS_SENT") throw err;
    }
  };
}

/**
 * Cancels a response nobody will read: an unread SSE body keeps its keep-alive
 * timer queueing chunks forever (#427), and an aborted signal doesn't stop it.
 *
 * Gives JSON answers a Content-Length. toNodeHandler writes headers before the
 * first chunk, so without one `compression` can't apply its size threshold.
 */
export function withResponseFraming(handler: FetchLikeMcpHandler): FetchLikeMcpHandler {
  return {
    fetch: async (request, options) => {
      const response = await handler.fetch(request, options);
      if (request.signal.aborted) {
        response.body?.cancel().catch(() => {});
        return response;
      }
      if (!response.body || !response.headers.get("content-type")?.includes("application/json")) return response;
      const body = await response.arrayBuffer();
      const headers = new Headers(response.headers);
      headers.set("content-length", String(body.byteLength));
      return new Response(body, { status: response.status, headers });
    },
  };
}
