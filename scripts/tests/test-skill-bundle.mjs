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
 *  - plugin/rijksmuseum-{claude,chatgpt}.zip (uploaded by hand): stale (via --check
 *    above), the other platform's manifest in the archive (Claude refuses more than
 *    one plugin.json), files nested under a folder, a skill copy that differs from
 *    the source, a manifest version off package.json, a renamed plugin, connector key
 *    or URL, an extra key on a server entry (the Agent Plugins schema rejects it), a
 *    wrong $schema, a top-level bin/ (claude.ai refuses the plugin), a lost display
 *    name, or a ChatGPT shortDescription over its 57-character cut.
 *  - A hard-wrapped paragraph or list item in the skill's Markdown, which ChatGPT's
 *    skill page shows as broken lines.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
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
check(".zip is a byte-identical copy of the .skill", readFileSync(join(ROOT, "skill", `${SKILL_NAME}.zip`)).equals(bundleBytes));

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

// Hand-written, not read from the server: the connector key is what users see and
// reconnect to, so changing it must be deliberate.
const SERVER_URL = "https://rijksmuseum-mcp-plus-production.up.railway.app/mcp";
const DISPLAY_NAME = "Rijksmuseum MCP+";
const SKILL_DISPLAY_NAME = "Rijksmuseum";
const claudeZip = readZip(readFileSync(join(ROOT, "plugin", "rijksmuseum-claude.zip")));
const chatgptZip = readZip(readFileSync(join(ROOT, "plugin", "rijksmuseum-chatgpt.zip")));
const zipJson = (zip, name) => JSON.parse(zip.get(name)?.toString("utf8") ?? "null");
const claudeManifest = zipJson(claudeZip, ".claude-plugin/plugin.json");
const portableManifest = zipJson(chatgptZip, "plugin.json");
check("the Claude zip has no Agent Plugins files", !claudeZip.has("plugin.json") && !claudeZip.has("mcp.json"));
check("the ChatGPT zip has no Claude files", ![...chatgptZip.keys()].some((n) => n.startsWith(".claude-plugin/") || n === ".mcp.json"));
for (const [label, zip, rels] of [
  ["Claude", claudeZip, sourceFiles.filter((rel) => !rel.startsWith("agents/"))],
  ["ChatGPT", chatgptZip, sourceFiles],
]) {
  const skillNames = [...zip.keys()].filter((n) => n.startsWith("skills/"));
  check(`the ${label} zip holds the skill folder`, skillNames.length === rels.length && rels.every((rel) => zip.get(`skills/${SKILL_NAME}/${rel}`)?.equals(bundle.get(`${SKILL_NAME}/${rel}`))), `${skillNames.length} vs ${rels.length}`);
  check(`the ${label} zip has no top-level bin/`, ![...zip.keys()].some((n) => n.startsWith("bin/")));
}
check("both plugin manifests are named rijksmuseum", claudeManifest?.name === "rijksmuseum" && portableManifest?.name === "rijksmuseum");
check("both plugin manifests carry package.json's version", claudeManifest?.version === pkg.version && portableManifest?.version === pkg.version);
check(`both plugin manifests show "${DISPLAY_NAME}"`, claudeManifest?.displayName === DISPLAY_NAME && portableManifest?.extensions?.["com.openai"]?.interface?.displayName === DISPLAY_NAME);
const shortDescription = portableManifest?.extensions?.["com.openai"]?.interface?.shortDescription ?? "";
check(`shortDescription is 1-57 characters (${shortDescription.length})`, shortDescription.length >= 1 && shortDescription.length <= 57);
check("plugin.json has the Agent Plugins schema", portableManifest?.$schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
const claudeMcp = zipJson(claudeZip, ".mcp.json");
const portableMcp = zipJson(chatgptZip, "mcp.json");
check(".mcp.json declares only the Rijksmuseum http server", isDeepStrictEqual(claudeMcp, { mcpServers: { Rijksmuseum: { type: "http", url: SERVER_URL } } }), JSON.stringify(claudeMcp));
check("mcp.json declares the same server as streamable-http", portableMcp?.$schema === "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" && isDeepStrictEqual(portableMcp.mcpServers, { Rijksmuseum: { type: "streamable-http", url: SERVER_URL } }), JSON.stringify(portableMcp));
const openaiYaml = readFileSync(join(SKILL_DIR, "agents", "openai.yaml"), "utf8");
check(`agents/openai.yaml shows the skill as "${SKILL_DISPLAY_NAME}"`, /^interface:\n {2}display_name: "Rijksmuseum"$/m.test(openaiYaml));

// A line continues the previous one unless either starts a block. Code fences are skipped.
const BLOCK_START = /^(#|\||>|---\s*$|\s*([-*]|\d+\.) )/;
for (const rel of sourceFiles.filter((f) => f.endsWith(".md"))) {
  let text = readFileSync(join(SKILL_DIR, rel), "utf8");
  if (rel === "SKILL.md") text = text.slice(text.indexOf("\n---\n", 4) + 5);
  const wrapped = [];
  let fence = false;
  let prev = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      fence = !fence;
      prev = "";
      continue;
    }
    if (fence) continue;
    if (line.trim() && prev.trim() && !BLOCK_START.test(line) && !/^(#|\||---\s*$)/.test(prev)) wrapped.push(line.slice(0, 60));
    prev = line;
  }
  check(`${rel} has one line per paragraph and list item`, wrapped.length === 0, `unwrap: ${wrapped[0]}`);
}

if (failures > 0) {
  console.error(`skill-bundle: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("skill-bundle: all checks passed");
