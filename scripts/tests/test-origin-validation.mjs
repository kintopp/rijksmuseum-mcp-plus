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

// What src/index.ts builds when MCP_ALLOWED_ORIGINS is unset.
const defaults = parseMcpAllowedOrigins(undefined);

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
  // A pattern missing its ^/$ anchor would let an attacker-controlled host
  // that merely contains an allowlisted name through.
  ["allowlisted name as a prefix",           "https://claude.ai.evil.example",       false],
  ["allowlisted subdomain as a prefix",      "https://www.claude.ai.evil.example",   false],
  ["allowlisted name as a suffix",           "https://evilclaude.ai",                false],
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

for (const [label, raw] of [["unset", undefined], ["empty string", ""], ["whitespace", "  "]]) {
  const list = parseMcpAllowedOrigins(raw);
  assert(
    isAllowedOrigin("https://claude.ai", list) && !isAllowedOrigin("https://evil.example", list),
    `${label} → the default allowlist`,
  );
}

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
// Entry dots are literal: an unescaped "." would match any character.
assert(isAllowedOrigin("https://fooXexample", custom) === false, "custom: '.' in an entry is literal");
assert(isAllowedOrigin("https://foo.example.evil", custom) === false, "custom: exact entry is anchored at the end");
assert(isAllowedOrigin("https://evil-foo.example", custom) === false, "custom: exact entry is anchored at the start");
assert(isAllowedOrigin("https://api.bar.example.evil", custom) === false, "custom: glob entry is anchored at the end");

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
