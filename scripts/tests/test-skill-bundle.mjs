#!/usr/bin/env node
/**
 * test-skill-bundle.mjs — the committed skill bundles match their source folder,
 * and SKILL.md's frontmatter conforms to the Agent Skills spec.
 *
 * Failure modes:
 *  - SKILL.md or a reference edited without `npm run build:skill`: stale bundle.
 *  - package.json bumped without a rebuild: stale metadata.version.
 *  - Builder emits consistent garbage: the bundles are parsed here independently.
 *  - Archive with loose files at its root, or macOS junk entries.
 *  - Top-level `version:`/`last_updated:`: only `metadata` may carry them, and the
 *    spec's validator rejects any other top-level key.
 *  - Skill folder renamed away from `name`, or a description over the 1024-char cap.
 *  - license or compatibility dropped. Their values are per-server choices, so only
 *    presence and the spec's length cap are checked.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_NAME = "rijksmuseum-mcp-plus";
const SKILL_DIR = join(ROOT, "skill", SKILL_NAME);
const SPEC_FIELDS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);

let failures = 0;
function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  ok: ${label}`);
  } else {
    failures++;
    console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Central directory first, as a real unzip reads it.
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end === -1) throw new Error("no end-of-central-directory record");
  const entries = new Map();
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central header at entry ${i}`);
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const data = buf.subarray(dataAt, dataAt + size);
    entries.set(name, method === 8 ? inflateRawSync(data) : data);
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return entries;
}

const rebuild = spawnSync(process.execPath, [join(ROOT, "scripts/build-skill.mjs"), "--check"], { encoding: "utf8" });
check("bundles and metadata.version are a rebuild of the source", rebuild.status === 0, rebuild.stderr.trim());

const bundleBytes = readFileSync(join(ROOT, "skill", `${SKILL_NAME}.skill`));
const bundle = readZip(bundleBytes);
check(".skill.zip is a byte-identical copy of the .skill", readFileSync(join(ROOT, "skill", `${SKILL_NAME}.skill.zip`)).equals(bundleBytes));

const names = [...bundle.keys()];
check("SKILL.md is the first entry, inside the skill folder", names[0] === `${SKILL_NAME}/SKILL.md`, names[0]);
check("every entry sits inside the skill folder", names.every((n) => n.startsWith(`${SKILL_NAME}/`)));
check("no macOS junk entries", !names.some((n) => /__MACOSX|\.DS_Store/.test(n)));

const sourceFiles = readdirSync(SKILL_DIR, { recursive: true })
  .map((rel) => String(rel).split(sep).join("/"))
  .filter((rel) => !rel.includes(".DS_Store") && statSync(join(SKILL_DIR, rel)).isFile());
check("bundle lists every source file", sourceFiles.length === names.length, `${sourceFiles.length} vs ${names.length}`);
for (const rel of sourceFiles) {
  check(`bundle matches ${rel}`, bundle.get(`${SKILL_NAME}/${rel}`)?.equals(readFileSync(join(SKILL_DIR, rel))));
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const bundledMd = bundle.get(`${SKILL_NAME}/SKILL.md`).toString("utf8");
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(bundledMd)?.[1] ?? "";
const lines = frontmatter.split("\n");

const topLevel = lines.map((l) => /^([A-Za-z_-]+):/.exec(l)?.[1]).filter(Boolean);
const offSpec = topLevel.filter((key) => !SPEC_FIELDS.has(key));
check("top-level frontmatter keys are all in the spec", offSpec.length === 0, offSpec.join(", "));
check("name matches the parent folder", /^name: (\S+)$/m.exec(frontmatter)?.[1] === SKILL_NAME);

const descStart = lines.findIndex((l) => l.startsWith("description:"));
const descEnd = lines.findIndex((l, i) => i > descStart && /^\S/.test(l));
const description = lines.slice(descStart + 1, descEnd).map((l) => l.trim()).join(" ");
check(`description is 1-1024 characters (${description.length})`, description.length >= 1 && description.length <= 1024);

check("license is present", /^license: \S/m.test(frontmatter));
const compatibility = /^compatibility: (.+)$/m.exec(frontmatter)?.[1] ?? "";
check(`compatibility is 1-500 characters (${compatibility.length})`, compatibility.length >= 1 && compatibility.length <= 500);

const metaStart = lines.indexOf("metadata:");
const metaEnd = lines.findIndex((l, i) => i > metaStart && /^\S/.test(l));
const metadata = lines.slice(metaStart + 1, metaEnd === -1 ? undefined : metaEnd);
check("metadata values are quoted strings", metadata.length > 0 && metadata.every((l) => /^ {2}[a-z_]+: ".*"$/.test(l)), metadata.join(" | "));
check("metadata.version equals package.json", metadata.includes(`  version: "${pkg.version}"`), metadata.join(" | "));
check("metadata.last_updated is a date", metadata.some((l) => /^ {2}last_updated: "\d{4}-\d{2}-\d{2}"$/.test(l)));

if (failures > 0) {
  console.error(`skill-bundle: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("skill-bundle: all checks passed");
