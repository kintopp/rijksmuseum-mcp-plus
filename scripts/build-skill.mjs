#!/usr/bin/env node
// Repack skill/rijksmuseum-mcp-plus/ into the committed .skill bundle and an
// identical .zip copy (Mistral Vibe rejects the .skill extension), after syncing
// SKILL.md's metadata.version from package.json. It also copies the folder into
// plugin/rijksmuseum/skills/ and writes the version into both plugin manifests:
// a marketplace installs the plugin from that git subdirectory alone, so the skill
// must sit there as real files, and installs update only when the version changes.
//
// A rebuild that changes nothing must be byte-identical on any machine, so the
// gate can compare bytes. Hence no system `zip`, timestamps from SKILL.md's
// metadata.last_updated (never the clock or an mtime), byte-ordered entries, and
// STORED entries, since DEFLATE output varies between zlib builds.
//
// Usage: npm run build:skill          rewrite the version and both bundles
//        node scripts/build-skill.mjs --check   exit 1 if anything is stale
//        (bundles, plugin skill copy or plugin manifest versions)

import { crc32 } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_NAME = "rijksmuseum-mcp-plus";
const SKILL_DIR = join(ROOT, "skill", SKILL_NAME);
const SKILL_MD = join(SKILL_DIR, "SKILL.md");
const OUT_SKILL = join(ROOT, "skill", `${SKILL_NAME}.skill`);
const OUT_ZIP = join(ROOT, "skill", `${SKILL_NAME}.zip`);
const PLUGIN_DIR = join(ROOT, "plugin", "rijksmuseum");
const PLUGIN_SKILL_DIR = join(PLUGIN_DIR, "skills", SKILL_NAME);
// Claude reads .claude-plugin/plugin.json; ChatGPT and Codex read the root plugin.json.
const PLUGIN_MANIFESTS = [join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), join(PLUGIN_DIR, "plugin.json")];

function withPackageVersion(md) {
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const synced = md.replace(/^ {2}version: .*$/m, `  version: "${version}"`);
  if (!/^metadata:\n(?: {2}.*\n)*? {2}version: /m.test(synced)) {
    throw new Error("SKILL.md has no metadata.version line to sync");
  }
  return synced;
}

function dosDateFrom(md) {
  const m = md.match(/^ {2}last_updated: "(\d{4})-(\d{2})-(\d{2})"$/m);
  if (!m) throw new Error('SKILL.md has no metadata.last_updated: "YYYY-MM-DD" line');
  return ((Number(m[1]) - 1980) << 9) | (Number(m[2]) << 5) | Number(m[3]);
}

function listFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map((rel) => String(rel).split(sep).join("/"))
    .filter((rel) => !rel.split("/").some((seg) => seg.startsWith(".")))
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

// Claude installs a skill from a folder, so every entry carries that folder level.
function skillEntries(md) {
  return listFiles(SKILL_DIR).map((rel) => ({
    rel,
    name: `${SKILL_NAME}/${rel}`,
    content: rel === "SKILL.md" ? Buffer.from(md, "utf8") : readFileSync(join(SKILL_DIR, rel)),
  }));
}

function buildZip(entries, dosDate) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const sum = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4); // version needed: 1.0, a stored entry uses no features
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by UNIX, so the mode below is read
    central.writeUInt16LE(10, 6);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, 0644
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, content);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + content.length;
  }
  const directory = Buffer.concat(centrals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

const source = readFileSync(SKILL_MD, "utf8");
const md = withPackageVersion(source);
const dosDate = dosDateFrom(md);
const entries = skillEntries(md);
const skill = buildZip(entries, dosDate);
const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const manifests = PLUGIN_MANIFESTS.map((path) => {
  const text = readFileSync(path, "utf8");
  return { path, text, synced: `${JSON.stringify({ ...JSON.parse(text), version }, null, 2)}\n` };
});

function pluginCopyStale() {
  let copied;
  try {
    copied = listFiles(PLUGIN_SKILL_DIR);
  } catch {
    return true;
  }
  return (
    copied.join("\n") !== entries.map((e) => e.rel).join("\n") ||
    entries.some((e) => !e.content.equals(readFileSync(join(PLUGIN_SKILL_DIR, e.rel))))
  );
}

if (process.argv.includes("--check")) {
  const stale = [];
  if (md !== source) stale.push("SKILL.md metadata.version differs from package.json");
  if (!skill.equals(readFileSync(OUT_SKILL))) stale.push(`${SKILL_NAME}.skill is not a rebuild of the folder`);
  if (!skill.equals(readFileSync(OUT_ZIP))) stale.push(`${SKILL_NAME}.zip is not a copy of the .skill`);
  if (pluginCopyStale()) stale.push(`plugin/rijksmuseum/skills/${SKILL_NAME}/ is not a copy of the skill folder`);
  for (const m of manifests) {
    if (m.text !== m.synced) stale.push(`${m.path.slice(ROOT.length + 1)} version differs from package.json`);
  }
  for (const line of stale) console.error(`stale: ${line}`);
  if (stale.length > 0) {
    console.error("run `npm run build:skill` and commit the result");
    process.exit(1);
  }
} else {
  writeFileSync(SKILL_MD, md);
  writeFileSync(OUT_SKILL, skill);
  writeFileSync(OUT_ZIP, skill);
  rmSync(join(PLUGIN_DIR, "skills"), { recursive: true, force: true });
  for (const { rel, content } of entries) {
    const dest = join(PLUGIN_SKILL_DIR, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  for (const m of manifests) writeFileSync(m.path, m.synced);
  console.error(`skill/${SKILL_NAME}.skill + .zip + plugin/rijksmuseum/ built from skill/${SKILL_NAME}/ (${skill.length} bytes)`);
}
