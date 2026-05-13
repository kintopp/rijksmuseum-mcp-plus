/**
 * Origin validation for the /mcp endpoint (DNS-rebinding mitigation).
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 *   "Servers MUST validate the Origin header on all incoming connections to
 *    prevent DNS rebinding attacks. If the Origin header is present and
 *    invalid, servers MUST respond with HTTP 403 Forbidden."
 *
 * Allow-by-category rules:
 *   - Missing Origin       → allow (CLI / stdio / server-to-server clients)
 *   - Non-http(s) scheme   → allow (Electron app://, browser chrome-extension://,
 *                                   file://, sandboxed-iframe "null" — none can
 *                                   be DNS-rebound)
 *   - Localhost / loopback → allow (any port — same-machine trust)
 *   - http(s) Origin       → allowed only if hostname matches an allowlist entry
 */

export const DEFAULT_WEB_HOST_PATTERNS: readonly RegExp[] = [
  /^claude\.ai$/i,
  /^.+\.claude\.ai$/i,
  /^chatgpt\.com$/i,
  /^.+\.chatgpt\.com$/i,
  /^.+\.openai\.com$/i,
];

export type OriginAllowlist = "*" | RegExp[];

/**
 * Parse the `MCP_ALLOWED_ORIGINS` env var.
 *
 *   unset / ""           → DEFAULT_WEB_HOST_PATTERNS
 *   "*"                  → "*"  (disables web-host validation)
 *   comma-separated list → replaces the defaults. Entries may be exact
 *                          origins ("https://foo.example") or hostname globs
 *                          ("*.foo.example"). One leading "*." wildcard supported.
 */
export function parseMcpAllowedOrigins(raw: string | undefined): OriginAllowlist {
  if (!raw || raw.trim() === "") return [...DEFAULT_WEB_HOST_PATTERNS];
  if (raw.trim() === "*") return "*";

  const patterns: RegExp[] = [];
  for (const entry of raw.split(",").map(s => s.trim()).filter(Boolean)) {
    patterns.push(entryToHostPattern(entry));
  }
  return patterns;
}

function entryToHostPattern(entry: string): RegExp {
  let host = entry;
  // Strip scheme if the operator wrote "https://foo.example"
  try {
    const u = new URL(entry);
    host = u.hostname;
  } catch {
    // Not a URL — treat as a bare hostname / glob
  }
  // Convert a single leading "*." glob into a subdomain wildcard
  const hasLeadingWildcard = host.startsWith("*.");
  const literal = hasLeadingWildcard ? host.slice(2) : host;
  const escaped = literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const pattern = hasLeadingWildcard ? "^.+\\." + escaped + "$" : "^" + escaped + "$";
  return new RegExp(pattern, "i");
}

/**
 * Returns true if the request should be allowed through to /mcp.
 * Pass the value of the `Origin` header (or undefined if absent).
 */
export function isAllowedOrigin(
  origin: string | undefined,
  allowlist: OriginAllowlist,
): boolean {
  if (origin === undefined) return true;          // no Origin → non-browser client

  // Sandboxed-iframe Origin: the literal string "null" (not a URL)
  if (origin === "null") return true;

  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;                                  // malformed Origin → reject
  }

  // Non-web schemes have no DNS, so no rebinding risk
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;

  // Localhost / loopback (any port) — same-machine trust
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") {
    return true;
  }

  if (allowlist === "*") return true;
  return allowlist.some(re => re.test(u.hostname));
}
