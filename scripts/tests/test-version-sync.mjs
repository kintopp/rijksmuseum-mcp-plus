#!/usr/bin/env node
/**
 * test-version-sync.mjs — one version across the three carriers. package.json is
 * the source of truth.
 *  - CITATION.cff `version` must equal the server's major.minor exactly.
 *  - skill/rijksmuseum-mcp-plus/SKILL.md `metadata.version` must equal it in full.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const cff = readFileSync(join(ROOT, "CITATION.cff"), "utf8");
const skill = readFileSync(join(ROOT, "skill/rijksmuseum-mcp-plus/SKILL.md"), "utf8");

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
const skillVersion = /^ {2}version:\s*"([^"]*)"\s*$/m.exec(frontmatter)?.[1];
check("SKILL.md frontmatter has metadata.version", skillVersion !== undefined, "no indented `version:` in frontmatter");
if (skillVersion !== undefined) {
  check(
    `SKILL.md metadata.version (${skillVersion}) equals package.json (${pkg.version})`,
    skillVersion === pkg.version,
    "run `npm run build:skill` and commit the result"
  );
}

if (failures > 0) {
  console.error(`version-sync: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("version-sync: all checks passed");
