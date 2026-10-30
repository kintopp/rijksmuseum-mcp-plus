import type { FetchLikeMcpHandler } from "@modelcontextprotocol/node";

/**
 * Answers 504 when `handler.fetch` hasn't produced a Response within `ms`, so a
 * stuck call fails visibly instead of being cut by the hosting proxy.
 *
 * The timeout resolves as the Response itself because toNodeHandler calls
 * `res.writeHead` unconditionally: a 504 written to `res` from outside would
 * make that throw. A stream's fetch resolves at once, so a long-lived
 * subscriptions/listen is never cut, and a 2025-era SSE tool call isn't covered.
 */
export function withResponseTimeout(handler: FetchLikeMcpHandler, ms: number): FetchLikeMcpHandler {
  return {
    fetch: async (request, options) => {
      let timer: NodeJS.Timeout | undefined;
      let timedOut = false;
      const timeout = new Promise<Response>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(Response.json({ error: "Request timeout" }, { status: 504 }));
        }, ms);
      });
      const served = handler.fetch(request, options).then((response) => {
        // Nobody will read a late response, and an unread SSE body keeps its
        // keep-alive timer queueing chunks forever (#427).
        if (timedOut) response.body?.cancel().catch(() => {});
        return response;
      });
      try {
        return await Promise.race([served, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
