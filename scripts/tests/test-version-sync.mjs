#!/usr/bin/env node
/**
 * test-version-sync.mjs — version-consistency gate across the three version
 * carriers: package.json (server, source of truth), CITATION.cff, and
 * docs/skills/rijksmuseum-mcp-plus/SKILL.md.
 *
 * Encodes the POLICY, not strict equality (versioning cadence: server releases
 * step in larger increments; SKILL.md takes point releases between them):
 *  - CITATION.cff `version` must equal the server's major.minor exactly.
 *  - SKILL.md `metadata.version` must share the server's major, be >= the
 *    server's minor, and stay within +9 of it (the between-releases window).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const cff = readFileSync(join(ROOT, "CITATION.cff"), "utf8");
const skill = readFileSync(join(ROOT, "docs/skills/rijksmuseum-mcp-plus/SKILL.md"), "utf8");

let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok: ${label}`);
  } else {
    failures++;
    console.error(`  FAIL: ${label} — ${detail}`);
  }
}

const serverMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version ?? "");
check("package.json version is X.Y.Z semver", !!serverMatch, `got ${JSON.stringify(pkg.version)}`);
if (!serverMatch) process.exit(1);
const [, sMajor, sMinor] = serverMatch.map(Number);

const cffMatch = /^version:\s*"?(\d+)\.(\d+)(?:\.(\d+))?"?\s*$/m.exec(cff);
check("CITATION.cff has a version field", !!cffMatch, "no `version:` line found");
if (cffMatch) {
  const [, cMajor, cMinor] = cffMatch.map(Number);
  check(
    `CITATION.cff version (${cMajor}.${cMinor}) equals server major.minor (${sMajor}.${sMinor})`,
    cMajor === sMajor && cMinor === sMinor,
    "CITATION.cff cites the server release — update it when package.json bumps"
  );
}

const fmEnd = skill.indexOf("---", 4);
const frontmatter = fmEnd === -1 ? "" : skill.slice(0, fmEnd);
const skillMatch = /^\s*version:\s*"?(\d+)\.(\d+)"?\s*$/m.exec(frontmatter);
check("SKILL.md frontmatter has metadata.version", !!skillMatch, "no `version:` in frontmatter");
if (skillMatch) {
  const [, kMajor, kMinor] = skillMatch.map(Number);
  check(
    `SKILL.md version (${kMajor}.${kMinor}) shares server major (${sMajor})`,
    kMajor === sMajor,
    "SKILL.md must be re-based when the server takes a major bump"
  );
  check(
    `SKILL.md minor (${kMinor}) is within [${sMinor}, ${sMinor + 9}] of server minor`,
    kMinor >= sMinor && kMinor <= sMinor + 9,
    kMinor < sMinor
      ? "SKILL.md lags the server release — bump it"
      : "SKILL.md ran past the point-release window — the server release is overdue a bump"
  );
}

if (failures > 0) {
  console.error(`version-sync: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("version-sync: all checks passed");
