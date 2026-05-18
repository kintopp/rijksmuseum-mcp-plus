// Phase 1b — helper call-graph via grep.
//
// Walks src/ for function definitions whose names start with
// format/build/render and counts call-sites for each. Helpers called
// from 2+ distinct enclosing functions are flagged as candidate
// duplication sources (the same `formatDimensions()` feeding both
// `dimensionStatement` and `physicalDimensions` is the canonical case).
//
// This is intentionally heuristic — not a real AST analyser. ts-morph
// would be more precise but adds 30 MB and 10 s of startup. For a
// re-runnable audit script, grep + simple regex is the right cost
// tradeoff. False positives are caught at the human-triage stage.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../../..");
const SRC_DIRS = ["src", "src/api", "src/utils"];
const HELPER_PREFIXES = ["format", "build", "render"];

function* walkSourceFiles() {
  for (const dir of SRC_DIRS) {
    const abs = path.join(PROJECT_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts")) continue;
      const full = path.join(abs, entry.name);
      yield { path: full, rel: path.relative(PROJECT_ROOT, full), text: fs.readFileSync(full, "utf8") };
    }
  }
}

/**
 * For each file: find function/arrow-function definitions whose name
 * starts with one of the helper prefixes, and find all call-sites of
 * the same names (anywhere in the codebase).
 */
export function buildHelperGraph() {
  const definitions = new Map(); // helperName -> { definedIn, kind }
  const callSites = new Map();   // helperName -> Set of fileRel
  const defRe = new RegExp(
    `(?:function|const|export\\s+function|export\\s+const)\\s+(${HELPER_PREFIXES.join("|")})([A-Z][A-Za-z0-9_]*)\\b`,
    "g",
  );

  // Pass 1: collect definitions
  const files = [...walkSourceFiles()];
  for (const f of files) {
    defRe.lastIndex = 0;
    let m;
    while ((m = defRe.exec(f.text)) !== null) {
      const name = m[1] + m[2];
      // Skip method-shorthand inside classes — the prefixes are loose.
      // Keep both top-level functions and class methods.
      definitions.set(name, { definedIn: f.rel });
    }
  }

  // Pass 2: count call sites for each known helper
  for (const f of files) {
    for (const name of definitions.keys()) {
      const callRe = new RegExp(`\\b${name}\\s*\\(`, "g");
      let count = 0;
      while (callRe.exec(f.text) !== null) count++;
      // Subtract the definition itself, which the regex also matched
      const isDefiner = definitions.get(name)?.definedIn === f.rel;
      const callOnly = isDefiner ? Math.max(0, count - 1) : count;
      if (callOnly > 0) {
        if (!callSites.has(name)) callSites.set(name, new Map());
        callSites.get(name).set(f.rel, callOnly);
      }
    }
  }

  const records = [];
  for (const [name, def] of definitions) {
    const sites = callSites.get(name);
    const totalCalls = sites ? [...sites.values()].reduce((a, b) => a + b, 0) : 0;
    const distinctFiles = sites ? sites.size : 0;
    records.push({
      name,
      definedIn: def.definedIn,
      totalCalls,
      distinctFiles,
      callSites: sites ? Object.fromEntries(sites) : {},
    });
  }
  // Sort by distinctFiles desc, then totalCalls desc — multi-file
  // reuse is the strongest cross-tool-duplication signal.
  records.sort((a, b) => b.distinctFiles - a.distinctFiles || b.totalCalls - a.totalCalls);
  return records;
}

/** Helpers called from >= 2 distinct files are "shared" — flag for inspection. */
export function flagSharedHelpers(records) {
  return records.filter(r => r.distinctFiles >= 2 || r.totalCalls >= 3);
}
