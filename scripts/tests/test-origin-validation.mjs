/**
 * Unit tests for /mcp Origin allowlist.
 *
 * Validates the pure helpers in src/utils/origin.ts that back the Express
 * middleware in src/index.ts. The middleware itself is a thin wrapper over
 * `isAllowedOrigin`, so testing the helper covers the spec-relevant behavior
 * without booting the HTTP server.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 *
 * Run:  node scripts/tests/test-origin-validation.mjs
 * Requires: npm run build
 */
import {
  isAllowedOrigin,
  parseMcpAllowedOrigins,
  DEFAULT_WEB_HOST_PATTERNS,
} from "../../dist/utils/origin.js";

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function section(name) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(60)}`);
}

// ══════════════════════════════════════════════════════════════════
section("1. Default allowlist — category rules");

const defaults = [...DEFAULT_WEB_HOST_PATTERNS];

const cases = [
  // [label, origin, expected]
  ["no Origin header",                       undefined,                              true],
  ["claude.ai (exact)",                      "https://claude.ai",                    true],
  ["workspace.claude.ai (subdomain glob)",   "https://workspace.claude.ai",          true],
  ["chatgpt.com (exact)",                    "https://chatgpt.com",                  true],
  ["codex.openai.com (*.openai.com)",        "https://codex.openai.com",             true],
  ["mistral.ai (exact)",                     "https://mistral.ai",                   true],
  ["chat.mistral.ai (*.mistral.ai)",         "https://chat.mistral.ai",              true],
  ["unibas.ch (exact)",                      "https://unibas.ch",                    true],
  ["dhlab.philhist.unibas.ch (*.unibas.ch)", "https://dhlab.philhist.unibas.ch",     true],
  ["localhost any port",                     "http://localhost:6274",                true],
  ["127.0.0.1 loopback",                     "http://127.0.0.1:5173",                true],
  ["IPv6 loopback",                          "http://[::1]:3000",                    true],
  ["non-web scheme (app://)",                "app://desktop-client.example",         true],
  ["non-web scheme (chrome-extension://)",   "chrome-extension://abcdef123",         true],
  ["sandboxed-iframe literal null",          "null",                                 true],
  ["unknown web host",                       "https://evil.example",                 false],
  ["malformed Origin",                       "not a url",                            false],
];

for (const [label, origin, expected] of cases) {
  const actual = isAllowedOrigin(origin, defaults);
  assert(actual === expected, `${label} → ${expected ? "allow" : "deny"}`);
}

// ══════════════════════════════════════════════════════════════════
section("2. Subdomain wildcard does not match bare apex outside list");

// Defensive check: ".+\.openai\.com" must NOT match "openai.com" itself
// (apex is not in our default allowlist — only subdomains are).
assert(
  isAllowedOrigin("https://openai.com", defaults) === false,
  "bare openai.com is denied (only *.openai.com is in the default list)",
);

// ══════════════════════════════════════════════════════════════════
section("3. parseMcpAllowedOrigins — env var handling");

assert(
  JSON.stringify(parseMcpAllowedOrigins(undefined).map(r => r.source)) ===
    JSON.stringify(DEFAULT_WEB_HOST_PATTERNS.map(r => r.source)),
  "unset → defaults",
);

assert(
  JSON.stringify(parseMcpAllowedOrigins("").map(r => r.source)) ===
    JSON.stringify(DEFAULT_WEB_HOST_PATTERNS.map(r => r.source)),
  "empty string → defaults",
);

assert(parseMcpAllowedOrigins("*") === "*", '"*" → "*" sentinel');

const custom = parseMcpAllowedOrigins("https://foo.example,*.bar.example");
assert(
  isAllowedOrigin("https://foo.example", custom) === true,
  "custom: exact origin entry matches",
);
assert(
  isAllowedOrigin("https://api.bar.example", custom) === true,
  "custom: *.bar.example glob matches subdomain",
);
assert(
  isAllowedOrigin("https://bar.example", custom) === false,
  "custom: *.bar.example glob does NOT match apex",
);
assert(
  isAllowedOrigin("https://claude.ai", custom) === false,
  "custom list REPLACES defaults (claude.ai no longer allowed)",
);

// ══════════════════════════════════════════════════════════════════
section('4. "*" disables web-host validation but keeps category rules');

const wildcard = parseMcpAllowedOrigins("*");
assert(
  isAllowedOrigin("https://any-random-host.example", wildcard) === true,
  "wildcard: arbitrary https host allowed",
);
assert(
  isAllowedOrigin("not a url", wildcard) === false,
  "wildcard: malformed Origin still denied",
);

// ══════════════════════════════════════════════════════════════════
section("5. Hostname comparison is case-insensitive (URL parser normalizes)");

assert(
  isAllowedOrigin("https://Claude.AI", defaults) === true,
  "mixed-case host normalizes to lowercase via URL parser",
);

// ══════════════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(60)}`);
console.log(`  Result: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}`);

if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
