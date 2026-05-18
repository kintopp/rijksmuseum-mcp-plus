// Pure analysis functions for the payload-redundancy audit.
// No I/O, no MCP. Easy to unit-test or re-run on captured responses.

// ── Schema flattening ─────────────────────────────────────────────

/**
 * Walk a JSON Schema (the output of tools/list outputSchemas) and yield
 * one record per leaf. Returns [{ path, kind, nullable, optional, description }, ...].
 */
export function flattenJsonSchema(schema, prefix = "", optional = false) {
  if (!schema || typeof schema !== "object") return [];
  const out = [];
  const nullable = schema.type === "null"
    || (Array.isArray(schema.type) && schema.type.includes("null"))
    || (Array.isArray(schema.anyOf) && schema.anyOf.some(s => s?.type === "null"));
  const baseType = Array.isArray(schema.type)
    ? schema.type.filter(t => t !== "null").join("|")
    : schema.type ?? null;

  if (schema.properties) {
    const required = new Set(schema.required ?? []);
    for (const [key, sub] of Object.entries(schema.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const subOpt = !required.has(key);
      out.push(...flattenJsonSchema(sub, path, subOpt));
    }
    return out;
  }

  if (schema.type === "array" && schema.items) {
    // Yield a container record so cross-tool name collisions can see this as
    // "array<object>" or "array<string>" rather than only the leaf children.
    // Without this, `dimensions` (array of objects in get_artwork_details)
    // and `dimensions` (string in browse_set.records[]) would not appear in
    // the same name bucket.
    const itemKind = schema.items.type === "object" || schema.items.properties
      ? "array<object>"
      : `array<${schema.items.type ?? "unknown"}>`;
    if (prefix) {
      out.push({
        path: prefix,
        kind: itemKind,
        nullable,
        optional,
        description: schema.description ?? null,
      });
    }
    out.push(...flattenJsonSchema(schema.items, `${prefix}[]`, optional));
    return out;
  }

  // Leaf (or anyOf at a leaf, e.g. nullable union)
  let resolvedKind = baseType;
  let resolvedNullable = nullable;
  if (Array.isArray(schema.anyOf)) {
    const nonNull = schema.anyOf.filter(s => s?.type !== "null");
    if (nonNull.length === 1) {
      // Recursively flatten the sole non-null branch so we see through
      // nullable-wrapped objects, arrays, and primitives uniformly.
      const branch = nonNull[0];
      if (branch.properties || branch.type === "array") {
        out.push(...flattenJsonSchema(branch, prefix, optional));
        return out;
      }
      if (branch.type) {
        resolvedKind = branch.type;
        resolvedNullable = true;
      }
    }
  }

  out.push({
    path: prefix,
    kind: resolvedKind ?? "unknown",
    nullable: resolvedNullable,
    optional,
    description: schema.description ?? null,
  });
  return out;
}

// ── Response value walking ─────────────────────────────────────────

/**
 * Walk a JS value and yield { path, value, bytes, kind } for every node,
 * including intermediate objects (for size attribution).
 */
export function* walkValue(value, prefix = "") {
  const kind = value === null ? "null"
    : Array.isArray(value) ? "array"
    : typeof value;
  const bytes = JSON.stringify(value)?.length ?? 0;
  yield { path: prefix || "$", value, bytes, kind };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      yield* walkValue(value[i], `${prefix}[${i}]`);
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      yield* walkValue(v, prefix ? `${prefix}.${k}` : k);
    }
  }
}

/** Aggregate per-field byte cost: keys are array-index-collapsed paths. */
export function bytesByField(structured) {
  const acc = new Map();
  for (const node of walkValue(structured)) {
    const collapsed = node.path.replace(/\[\d+\]/g, "[]");
    acc.set(collapsed, (acc.get(collapsed) ?? 0) + node.bytes);
  }
  return acc;
}

// ── Structured ↔ text presence diff ────────────────────────────────

/** Quick lossy normalisation for substring search. Casefold, drop punctuation. */
function norm(s) {
  return String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * For each leaf string/number in structured, check if its value appears in
 * the text channel. Returns array of { path, value, present, sampleSubstrLen }.
 * Long strings: try the longest substring up to 60 chars from the start, then
 * fall back to a 20-char window from the middle.
 */
export function presenceDiff(structured, text) {
  const normText = norm(text);
  const findings = [];
  for (const node of walkValue(structured)) {
    if (node.value == null) continue;
    if (typeof node.value !== "string" && typeof node.value !== "number") continue;
    const raw = String(node.value);
    if (raw.length < 3) continue;
    const probe = raw.length <= 60 ? raw : raw.slice(0, 60);
    const present = normText.includes(norm(probe));
    let altPresent = false;
    if (!present && raw.length > 60) {
      const mid = raw.slice(Math.floor(raw.length / 2) - 10, Math.floor(raw.length / 2) + 10);
      altPresent = normText.includes(norm(mid));
    }
    findings.push({
      path: node.path.replace(/\[\d+\]/g, "[]"),
      valueSample: raw.slice(0, 80),
      bytes: raw.length,
      present: present || altPresent,
    });
  }
  return findings;
}

// ── Intra-field self-duplication ───────────────────────────────────

/**
 * Split a long string on `|`, then ` | `, then `; `, then `\n`. Returns
 * blocks of length >= 8 chars. Pipe-delimited cataloguer text is the
 * primary target.
 */
function blocks(str) {
  if (str.length < 200) return null;
  const parts = str.split("|").map(s => s.trim()).filter(s => s.length >= 8);
  return parts.length >= 4 ? parts : null;
}

/** Cheap normalised similarity: token Jaccard. */
function jaccard(a, b) {
  const ta = new Set(norm(a).split(" ").filter(t => t.length >= 2));
  const tb = new Set(norm(b).split(" ").filter(t => t.length >= 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Detect NL ↔ EN translation parallels via a small stopword cue. */
function languageHint(s) {
  const t = norm(s);
  const nlCue = /\b(lengte|breedte|hoogte|gewicht|diepte|deel|lijst|spieraam|maten|inclusief|huidige)\b/.test(t);
  const enCue = /\b(length|width|height|weight|depth|part|frame|inscription)\b/.test(t);
  if (nlCue && !enCue) return "nl";
  if (enCue && !nlCue) return "en";
  return null;
}

/**
 * Returns { blockCount, dupPairs, translationPairs, overallRedundancy } or null
 * if the string is too short / not block-structured.
 */
export function intraFieldDup(str) {
  if (typeof str !== "string") return null;
  const parts = blocks(str);
  if (!parts) return null;
  const pairs = [];
  const tPairs = [];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const sim = jaccard(parts[i], parts[j]);
      if (sim >= 0.5) pairs.push({ i, j, sim });
      else {
        // Detect translation duplicate (different language, same numbers)
        const li = languageHint(parts[i]);
        const lj = languageHint(parts[j]);
        if (li && lj && li !== lj) {
          const numsI = (parts[i].match(/\d+([.,]\d+)?/g) ?? []).map(s => s.replace(",", "."));
          const numsJ = (parts[j].match(/\d+([.,]\d+)?/g) ?? []).map(s => s.replace(",", "."));
          const overlap = numsI.filter(n => numsJ.includes(n)).length;
          if (numsI.length >= 2 && overlap >= Math.min(numsI.length, numsJ.length) * 0.6) {
            tPairs.push({ i, j, overlap, total: Math.max(numsI.length, numsJ.length) });
          }
        }
      }
    }
  }
  const duplicatedBlockIndices = new Set();
  for (const p of pairs) { duplicatedBlockIndices.add(p.i); duplicatedBlockIndices.add(p.j); }
  for (const p of tPairs) { duplicatedBlockIndices.add(p.i); duplicatedBlockIndices.add(p.j); }
  return {
    blockCount: parts.length,
    dupPairs: pairs.length,
    translationPairs: tPairs.length,
    overallRedundancy: duplicatedBlockIndices.size / parts.length,
    totalBytes: str.length,
    sampleBlocks: parts.slice(0, 3),
  };
}

// ── Text-only signals (reverse of dead bytes) ──────────────────────

/**
 * Parse a tool's text channel for `[Label] value` and `Label: value`
 * patterns, then check whether each label has a corresponding key in
 * the structured channel. Labels without a structured counterpart
 * are candidate "text-only signals" — facts computed at render time
 * that have no structured-channel home.
 *
 * Returns array of { label, valueSample, reason }.
 *
 * Heuristic: a label "maps to" structured if some flattened field path
 * (or any object key in the response) contains the normalised label
 * token. Examples:
 *   - text label "Description" maps to structured `description`
 *   - text label "Provenance parsed" maps to no structured key
 *     (the parsed chain is computed in formatDetailSummary, not stored)
 *
 * Filters out:
 *   - very short values (< 12 chars)
 *   - labels that are obviously CSS-like or unrelated (start with a digit, etc.)
 *   - labels whose tokens overlap with any structured key fragment
 */
export function findTextOnlySignals(text, structured) {
  if (!text || typeof text !== "string") return [];
  const structuredKeys = collectAllKeys(structured);
  const structuredKeysLower = new Set([...structuredKeys].map(k => k.toLowerCase()));
  const structuredText = JSON.stringify(structured ?? {}).toLowerCase();

  const findings = [];
  const lines = text.split("\n");
  const labelPattern1 = /^\s*\[([^\]]+)\]\s+(.+)$/;
  const labelPattern2 = /^\s*([A-Z][\w][\w\- ]*?):\s+(.+)$/;

  for (const line of lines) {
    let m = labelPattern1.exec(line) || labelPattern2.exec(line);
    if (!m) continue;
    const label = m[1].trim();
    const value = m[2].trim();
    if (value.length < 12) continue;
    if (/^https?:/.test(value)) continue; // URLs handled elsewhere
    // Build label tokens (case-fold, drop short tokens)
    const tokens = label.toLowerCase()
      .split(/\s+/)
      .map(t => t.replace(/[^a-z]/g, ""))
      .filter(t => t.length >= 4);
    if (tokens.length === 0) continue;
    // Does any token map to a structured key?
    const hasKey = tokens.some(t => {
      for (const k of structuredKeysLower) {
        if (k.includes(t) || t.includes(k)) return true;
      }
      return false;
    });
    if (hasKey) continue;
    // Does the *value* appear in structured anywhere? (probe the first 40 chars)
    const probe = value.slice(0, 40).toLowerCase();
    const valuePresent = structuredText.includes(probe);
    findings.push({
      label,
      valueSample: value.length > 100 ? value.slice(0, 100) + "…" : value,
      valuePresentInStructured: valuePresent,
      reason: valuePresent
        ? "label has no structured key, but value text appears in structured — likely a derived rendering"
        : "label has no structured key AND value text not found in structured — candidate text-only computed signal",
    });
  }
  return findings;
}

function collectAllKeys(value, acc = new Set()) {
  if (!value || typeof value !== "object") return acc;
  if (Array.isArray(value)) {
    for (const v of value) collectAllKeys(v, acc);
  } else {
    for (const k of Object.keys(value)) {
      acc.add(k);
      collectAllKeys(value[k], acc);
    }
  }
  return acc;
}

// ── Cross-tool collisions ──────────────────────────────────────────

/**
 * From a list of flattened schema records keyed by tool, build a
 * map of field name -> [{tool, path, kind, ...}, ...].
 * Name collision = same final segment, regardless of nesting.
 */
export function buildNameIndex(toolSchemas) {
  const index = new Map();
  for (const [tool, fields] of Object.entries(toolSchemas)) {
    for (const f of fields) {
      const leaf = f.path.split(".").pop().replace(/\[\]/g, "");
      if (!leaf) continue;
      const entry = { tool, ...f };
      if (!index.has(leaf)) index.set(leaf, []);
      index.get(leaf).push(entry);
    }
  }
  return index;
}

/**
 * Cross-tool name collisions where the shape (kind) differs.
 * High-confidence findings: same key name, mismatched primitive type.
 */
export function findShapeCollisions(nameIndex) {
  const out = [];
  for (const [name, entries] of nameIndex) {
    if (entries.length < 2) continue;
    const tools = new Set(entries.map(e => e.tool));
    if (tools.size < 2) continue;
    const kinds = new Set(entries.map(e => e.kind));
    if (kinds.size > 1) {
      out.push({
        name,
        kinds: [...kinds],
        occurrences: entries.map(e => ({ tool: e.tool, path: e.path, kind: e.kind })),
      });
    }
  }
  return out;
}

/**
 * Same key name across tools with the *same* shape — potential aliases or
 * confirmed reuse. Caller decides which by inspecting captured values.
 */
export function findSameNameSameShape(nameIndex) {
  const out = [];
  for (const [name, entries] of nameIndex) {
    const tools = new Set(entries.map(e => e.tool));
    if (tools.size < 2) continue;
    const kinds = new Set(entries.map(e => e.kind));
    if (kinds.size === 1) {
      out.push({
        name,
        kind: [...kinds][0],
        tools: [...tools],
        occurrences: entries.map(e => ({ tool: e.tool, path: e.path })),
      });
    }
  }
  return out;
}

// ── Value-level alias detection ────────────────────────────────────

/**
 * For each pair of captured responses on the same anchor artwork,
 * find leaf string values that appear under different keys.
 * Returns array of { value, occurrences: [{tool, fixture, path}, ...] }.
 * Filters: value must be a string of length >= 8 (to skip noise),
 * and must appear under >= 2 distinct path-names.
 */
export function findValueAliases(capturesByAnchor) {
  const out = [];
  for (const [anchor, captures] of Object.entries(capturesByAnchor)) {
    const byValue = new Map();
    for (const cap of captures) {
      for (const node of walkValue(cap.structured)) {
        if (typeof node.value !== "string") continue;
        if (node.value.length < 8 || node.value.length > 300) continue;
        const v = node.value;
        if (!byValue.has(v)) byValue.set(v, []);
        const collapsed = node.path.replace(/\[\d+\]/g, "[]");
        byValue.get(v).push({ tool: cap.tool, fixture: cap.fixture, path: collapsed });
      }
    }
    for (const [value, occs] of byValue) {
      const distinctPaths = new Set(occs.map(o => `${o.tool}:${o.path}`));
      const distinctNames = new Set(occs.map(o => o.path.split(".").pop()));
      if (distinctPaths.size >= 2 && distinctNames.size >= 2) {
        out.push({
          anchor,
          value: value.length > 80 ? value.slice(0, 80) + "…" : value,
          fullLength: value.length,
          occurrences: occs,
        });
      }
    }
  }
  return out;
}

// ── Derivable string from structured array ─────────────────────────

/**
 * Try known synthesisers to see if `stringField` can be reproduced from
 * `arrayField`. Returns { matched, synthesiser } or null.
 *
 * Recognised patterns:
 *  - formatDimensions: "h {h} cm × w {w} cm"
 *  - simple-extent: "h {h} {unit} x w {w} {unit}"
 */
export function tryDeriveString(arr, str) {
  if (!Array.isArray(arr) || typeof str !== "string") return null;
  const byType = new Map(arr.map(e => [e?.type, e]));
  const h = byType.get("height");
  const w = byType.get("width");
  if (h && w) {
    const a = `h ${h.value} ${h.unit} × w ${w.value} ${w.unit}`;
    if (str === a) return { matched: true, synthesiser: "formatDimensions" };
    const b = `h ${h.value} ${h.unit} x w ${w.value} ${w.unit}`;
    if (str === b) return { matched: true, synthesiser: "formatDimensions-ascii-x" };
    // Substring match — the string starts with the formatted version.
    if (str.startsWith(a) || str.startsWith(b)) {
      return { matched: true, synthesiser: "formatDimensions-prefix" };
    }
  }
  return null;
}

// ── Severity scoring ───────────────────────────────────────────────

/**
 * Compose a severity score in [0, 100]. Inputs:
 *  - bytesWasted: estimated wasted bytes per call
 *  - callsPerDay: from UsageStats (default 1 if unknown)
 *  - classWeight: per-class multiplier (collisions are higher than dead bytes)
 */
export function severity({ bytesWasted = 0, callsPerDay = 1, classWeight = 1 }) {
  const raw = Math.log10(1 + bytesWasted * callsPerDay) * classWeight * 10;
  return Math.min(100, Math.max(0, Math.round(raw)));
}
