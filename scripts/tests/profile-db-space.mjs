#!/usr/bin/env node
/**
 * profile-db-space.mjs — Systematic vocabulary DB space profiling
 *
 * Analyses every table, column, and index in vocabulary.db using the dbstat
 * virtual table and outputs a markdown report with concrete savings estimates.
 *
 * Usage:
 *   node scripts/profile-db-space.mjs                        # default: data/vocabulary.db
 *   node scripts/profile-db-space.mjs /path/to/vocabulary.db  # custom path
 *   node scripts/profile-db-space.mjs > report.md             # save output
 */

import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n, decimals = 1) {
  return n.toFixed(decimals);
}

function fmtMB(bytes) {
  return fmt(bytes / 1048576.0);
}

function pct(part, whole) {
  return whole > 0 ? fmt((part / whole) * 100) : "0.0";
}

function padR(s, w) {
  return String(s).padEnd(w);
}
function padL(s, w) {
  return String(s).padStart(w);
}

function mdTable(headers, rows, alignments) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length))
  );
  const sep = widths.map((w, i) => {
    const a = alignments?.[i] ?? "l";
    if (a === "r") return "-".repeat(w - 1) + ":";
    if (a === "c") return ":" + "-".repeat(w - 2) + ":";
    return "-".repeat(w);
  });
  const line = (cells) =>
    "| " + cells.map((c, i) => padR(String(c ?? ""), widths[i])).join(" | ") + " |";
  return [line(headers), "| " + sep.join(" | ") + " |", ...rows.map(line)].join(
    "\n"
  );
}

// ── Open DB ──────────────────────────────────────────────────────────────────

function openDb(path) {
  if (!existsSync(path)) {
    console.error(`Error: DB not found at ${path}`);
    process.exit(1);
  }
  const sizeMB = statSync(path).size / 1048576.0;
  const db = new Database(path, { readonly: true });
  db.pragma("mmap_size = 3221225472");
  return { db, sizeMB };
}

// ── 1. Table & Index Sizes via dbstat ────────────────────────────────────────

function profileTableSizes(db) {
  const rows = db
    .prepare(
      `SELECT name, SUM(pgsize) AS size_bytes, COUNT(*) AS pages
       FROM dbstat GROUP BY name ORDER BY size_bytes DESC`
    )
    .all();
  const totalBytes = rows.reduce((s, r) => s + r.size_bytes, 0);
  return { rows, totalBytes };
}

// ── 2. Per-Column Analysis ───────────────────────────────────────────────────

function profileColumns(db, table) {
  // Get column names (excluding virtual/generated)
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const totalRows = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const results = [];

  for (const col of cols) {
    const c = col.name;
    const stats = db
      .prepare(
        `SELECT COUNT(${c}) AS non_null,
                COUNT(DISTINCT ${c}) AS distinct_vals,
                SUM(LENGTH(${c})) AS data_bytes,
                AVG(LENGTH(${c})) AS avg_len,
                MAX(LENGTH(${c})) AS max_len
         FROM ${table}`
      )
      .get();

    // Top-10 most frequent values (for normalization candidates)
    let top10 = [];
    if (stats.distinct_vals > 0 && stats.distinct_vals <= 1000000) {
      try {
        top10 = db
          .prepare(
            `SELECT ${c} AS val, COUNT(*) AS cnt
             FROM ${table} WHERE ${c} IS NOT NULL
             GROUP BY ${c} ORDER BY cnt DESC LIMIT 10`
          )
          .all();
      } catch {
        // skip if column type doesn't support grouping
      }
    }

    results.push({
      column: c,
      type: col.type,
      totalRows,
      nonNull: stats.non_null,
      nullCount: totalRows - stats.non_null,
      distinctVals: stats.distinct_vals,
      dataBytes: stats.data_bytes || 0,
      avgLen: stats.avg_len || 0,
      maxLen: stats.max_len || 0,
      top10,
    });
  }
  return results;
}

// ── 3. Mappings Deep-Dive ────────────────────────────────────────────────────

function profileMappings(db) {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM mappings`).get().n;

  const keyStats = db
    .prepare(
      `SELECT AVG(LENGTH(object_number)) AS avg_on_len,
              MAX(LENGTH(object_number)) AS max_on_len,
              AVG(LENGTH(vocab_id)) AS avg_vid_len,
              MAX(LENGTH(vocab_id)) AS max_vid_len,
              AVG(LENGTH(field)) AS avg_field_len,
              MAX(LENGTH(field)) AS max_field_len
       FROM mappings`
    )
    .get();

  const cardinality = db
    .prepare(
      `SELECT COUNT(DISTINCT object_number) AS distinct_on,
              COUNT(DISTINCT vocab_id) AS distinct_vid,
              COUNT(DISTINCT field) AS distinct_field
       FROM mappings`
    )
    .get();

  // Per-field breakdown
  const perField = db
    .prepare(
      `SELECT field, COUNT(*) AS rows,
              SUM(LENGTH(object_number) + LENGTH(vocab_id) + LENGTH(field)) AS payload_bytes
       FROM mappings GROUP BY field ORDER BY rows DESC`
    )
    .all();

  // Integer-encoding savings estimate
  // B-tree overhead (~8 bytes/row) is approximate and identical for current/future
  // layouts, so it cancels partially in the ratio. The 8-byte constant understates
  // actual TEXT overhead (variable-length record headers), making estimates conservative.
  const OVERHEAD = 8;
  const avgOn = keyStats.avg_on_len || 0;
  const avgVid = keyStats.avg_vid_len || 0;
  const avgField = keyStats.avg_field_len || 0;

  // Table row (all 3 columns)
  const currentAvgRow = avgOn + avgVid + avgField + OVERHEAD;
  const partialIntAvgRow = 4 + 4 + avgField + OVERHEAD; // ON+VID as INT
  const fullIntAvgRow = 4 + 4 + 1 + OVERHEAD;           // all 3 as INT

  // Per-column current/future sizes (for per-index savings computation)
  const colSizes = {
    object_number: { current: avgOn, future: 4 },
    vocab_id:      { current: avgVid, future: 4 },
    field:         { current: avgField, future: 1 },
  };

  return {
    total,
    keyStats,
    cardinality,
    perField,
    currentAvgRow,
    partialIntAvgRow,
    fullIntAvgRow,
    colSizes,
  };
}

// ── 4. Index Analysis ────────────────────────────────────────────────────────

function profileIndexes(db, tableSizes) {
  const indexes = db
    .prepare(
      `SELECT name, tbl_name, sql FROM sqlite_master
       WHERE type='index' AND sql IS NOT NULL
       ORDER BY tbl_name, name`
    )
    .all();

  // Parse column lists from CREATE INDEX statements
  const parsed = indexes.map((idx) => {
    const match = idx.sql.match(/\(([^)]+)\)/);
    const columns = match
      ? match[1]
          .split(",")
          .map((c) => c.trim().replace(/ COLLATE \w+/i, "").replace(/ (ASC|DESC)/i, ""))
      : [];
    const isPartial = /WHERE/i.test(idx.sql);
    const sizeRow = tableSizes.find((r) => r.name === idx.name);
    const sizeMB = sizeRow ? sizeRow.size_bytes / 1048576.0 : 0;
    return { ...idx, columns, isPartial, sizeMB };
  });

  // Prefix redundancy detection
  const redundancies = [];
  for (const a of parsed) {
    for (const b of parsed) {
      if (
        a.name !== b.name &&
        a.tbl_name === b.tbl_name &&
        !a.isPartial &&
        !b.isPartial &&
        a.columns.length < b.columns.length &&
        a.columns.every((col, i) => col === b.columns[i])
      ) {
        redundancies.push({
          redundant: a.name,
          coveredBy: b.name,
          redundantCols: a.columns,
          coveringCols: b.columns,
          savingsMB: a.sizeMB,
        });
      }
    }
  }

  // Runtime vs harvest-only classification
  // Harvest-only: idx_artworks_tier2 (used during Phase 2 tier2 harvesting)
  const HARVEST_ONLY = new Set(["idx_artworks_tier2"]);

  return { parsed, redundancies, HARVEST_ONLY };
}

// ── 5. Normalization Candidates ──────────────────────────────────────────────

function findNormalizationCandidates(columnProfiles) {
  const candidates = [];
  for (const [table, cols] of Object.entries(columnProfiles)) {
    for (const col of cols) {
      // Low cardinality + high row count = normalization candidate
      if (
        col.distinctVals > 0 &&
        col.distinctVals < 500 &&
        col.nonNull > 10000 &&
        col.dataBytes > 1048576
      ) {
        const fkBytes = col.distinctVals <= 256 ? 1 : col.distinctVals <= 65536 ? 2 : 4;
        const intSavings = col.dataBytes - col.nonNull * fkBytes;
        if (intSavings > 0) {
          candidates.push({
            table,
            column: col.column,
            distinctVals: col.distinctVals,
            nonNull: col.nonNull,
            dataMB: col.dataBytes / 1048576.0,
            savingsMB: intSavings / 1048576.0,
            top3: col.top10.slice(0, 3),
          });
        }
      }
    }
  }
  return candidates.sort((a, b) => b.savingsMB - a.savingsMB);
}

// ── 6. Summary & Strategy Table ──────────────────────────────────────────────

function buildStrategies(
  fileSizeMB,
  tableSizes,
  mappingsProfile,
  indexAnalysis,
  normCandidates,
  columnProfiles
) {
  const strategies = [];

  // ── Mappings integer encoding (all 3 columns) ─────────────────────────
  // Compute savings per-component using column-aware ratios.
  // Each B-tree stores a subset of columns; apply the ratio for those columns only.
  const cs = mappingsProfile.colSizes;
  const OVERHEAD = 8;

  // Helper: savings ratio for a given set of columns
  function indexSavingsRatio(columns) {
    let currentKey = OVERHEAD;
    let futureKey = OVERHEAD;
    for (const col of columns) {
      const s = cs[col];
      if (s) {
        currentKey += s.current;
        futureKey += s.future;
      }
    }
    return currentKey > 0 ? 1 - futureKey / currentKey : 0;
  }

  // Table + PK autoindex: all 3 columns
  const allCols = ["object_number", "vocab_id", "field"];
  const tableRatio = indexSavingsRatio(allCols);

  const mappingsSize =
    tableSizes.find((r) => r.name === "mappings")?.size_bytes / 1048576.0 || 0;
  const mappingsAutoIdx =
    tableSizes.find((r) => r.name === "sqlite_autoindex_mappings_1")?.size_bytes /
      1048576.0 || 0;
  let totalSavingsMB = (mappingsSize + mappingsAutoIdx) * tableRatio;
  const mappingsTotal = mappingsSize + mappingsAutoIdx;

  // Secondary indexes: per-index ratio based on covered columns
  let secIdxTotal = 0;
  for (const idx of indexAnalysis.parsed.filter((i) => i.tbl_name === "mappings")) {
    const ratio = indexSavingsRatio(idx.columns);
    totalSavingsMB += idx.sizeMB * ratio;
    secIdxTotal += idx.sizeMB;
  }

  const mappingsAllMB = mappingsTotal + secIdxTotal;
  const effectiveRatio = mappingsAllMB > 0 ? totalSavingsMB / mappingsAllMB : 0;
  strategies.push({
    strategy: "Integer-encode all mappings columns",
    component: "mappings table + PK + indexes",
    currentMB: fmt(mappingsAllMB),
    savingsMB: fmt(totalSavingsMB),
    complexity: "High",
    notes: `ON→INT4, VID→INT4, field→INT1 (${fmt(effectiveRatio * 100)}% effective reduction)`,
  });

  // ── Index prefix redundancy ────────────────────────────────────────────
  for (const r of indexAnalysis.redundancies) {
    strategies.push({
      strategy: `Drop redundant ${r.redundant}`,
      component: r.redundant,
      currentMB: fmt(r.savingsMB),
      savingsMB: fmt(r.savingsMB),
      complexity: "Low",
      notes: `Prefix of ${r.coveredBy} (${r.redundantCols.join(",")} ⊂ ${r.coveringCols.join(",")})`,
    });
  }

  // ── Harvest-only indexes ───────────────────────────────────────────────
  for (const idx of indexAnalysis.parsed) {
    if (indexAnalysis.HARVEST_ONLY.has(idx.name)) {
      strategies.push({
        strategy: `Drop harvest-only ${idx.name}`,
        component: idx.name,
        currentMB: fmt(idx.sizeMB),
        savingsMB: fmt(idx.sizeMB),
        complexity: "Low",
        notes: "Only used during Phase 2 tier2 harvesting",
      });
    }
  }

  // ── Derived column elimination ─────────────────────────────────────────
  // linked_art_uri is deterministic: "https://id.rijksmuseum.nl/" + numeric id
  const linkedArt = columnProfiles.artworks?.find(
    (c) => c.column === "linked_art_uri"
  );
  if (linkedArt && linkedArt.dataBytes > 0) {
    strategies.push({
      strategy: "Drop artworks.linked_art_uri",
      component: "artworks.linked_art_uri",
      currentMB: fmt(linkedArt.dataBytes / 1048576.0),
      savingsMB: fmt(linkedArt.dataBytes / 1048576.0),
      complexity: "Low",
      notes: "Derivable from object_number at query time",
    });
  }

  // ── Column normalization (excluding mappings.field — already in INT strategy) ──
  for (const c of normCandidates.filter(
    (c) => !(c.table === "mappings" && c.column === "field")
  ).slice(0, 5)) {
    strategies.push({
      strategy: `Normalize ${c.table}.${c.column}`,
      component: `${c.table}.${c.column}`,
      currentMB: fmt(c.dataMB),
      savingsMB: fmt(c.savingsMB),
      complexity: "Medium",
      notes: `${c.distinctVals} distinct vals, ${c.nonNull.toLocaleString()} rows`,
    });
  }

  // ── VACUUM (free-space reclaim) ────────────────────────────────────────
  const dbstatTotal = tableSizes.reduce((s, r) => s + r.size_bytes, 0) / 1048576.0;
  const freeSpace = fileSizeMB - dbstatTotal;
  if (freeSpace > 1) {
    strategies.push({
      strategy: "VACUUM",
      component: "free pages",
      currentMB: fmt(freeSpace),
      savingsMB: fmt(freeSpace),
      complexity: "Low",
      notes: "Reclaim unused pages (file size − dbstat total)",
    });
  }

  return strategies;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const dbPath = process.argv[2] || resolve(PROJECT_ROOT, "data/vocabulary.db");
  const { db, sizeMB } = openDb(dbPath);

  const out = [];
  const print = (s = "") => out.push(s);

  print("# Vocabulary DB Space Profile");
  print();
  print(`**File:** \`${dbPath}\``);
  print(`**File size:** ${fmt(sizeMB)} MB (${fmt(sizeMB / 1024, 2)} GB)`);
  print(`**Date:** ${new Date().toISOString().slice(0, 10)}`);
  print();

  // ── 1. Table/Index Sizes ─────────────────────────────────────────────────

  print("## 1. Table & Index Sizes");
  print();
  const { rows: tableSizes, totalBytes } = profileTableSizes(db);
  const totalMB = totalBytes / 1048576.0;

  const sizeHeaders = ["Name", "Size (MB)", "Pages", "% of DB"];
  const sizeAligns = ["l", "r", "r", "r"];
  const sizeRows = tableSizes.map((r) => [
    r.name,
    fmtMB(r.size_bytes),
    r.pages.toLocaleString(),
    pct(r.size_bytes, totalBytes),
  ]);
  sizeRows.push(["**TOTAL (dbstat)**", `**${fmt(totalMB)}**`, "", "100.0"]);
  print(mdTable(sizeHeaders, sizeRows, sizeAligns));
  print();

  const freeSpace = sizeMB - totalMB;
  if (freeSpace > 1) {
    print(
      `> **Free space:** ${fmt(freeSpace)} MB (file size − dbstat total). Reclaimable via VACUUM.`
    );
    print();
  }

  // ── 2. Column-Level Analysis ─────────────────────────────────────────────

  const columnProfiles = {};
  const tableLabels = { artworks: "2a", vocabulary: "2b", mappings: "2c" };
  for (const table of ["artworks", "vocabulary", "mappings"]) {
    print(`## ${tableLabels[table]}. Column Analysis: \`${table}\``);
    print();

    const cols = profileColumns(db, table);
    columnProfiles[table] = cols;

    const colHeaders = [
      "Column",
      "Type",
      "Non-NULL",
      "NULL",
      "Distinct",
      "Data (MB)",
      "Avg Len",
      "Max Len",
    ];
    const colAligns = ["l", "l", "r", "r", "r", "r", "r", "r"];
    const colRows = cols.map((c) => [
      c.column,
      c.type,
      c.nonNull.toLocaleString(),
      c.nullCount.toLocaleString(),
      c.distinctVals.toLocaleString(),
      fmtMB(c.dataBytes),
      fmt(c.avgLen, 1),
      c.maxLen,
    ]);
    print(mdTable(colHeaders, colRows, colAligns));
    print();

    // Show top-10 for low-cardinality columns
    const lowCard = cols.filter(
      (c) => c.distinctVals > 0 && c.distinctVals <= 200 && c.nonNull > 1000
    );
    if (lowCard.length > 0) {
      print(`### Low-cardinality columns (≤200 distinct values)`);
      print();
      for (const c of lowCard) {
        print(`**${c.column}** — ${c.distinctVals} distinct, ${c.nonNull.toLocaleString()} non-null, ${fmtMB(c.dataBytes)} MB`);
        if (c.top10.length > 0) {
          print("```");
          for (const t of c.top10) {
            const valStr =
              t.val === null
                ? "NULL"
                : String(t.val).length > 80
                  ? String(t.val).slice(0, 77) + "..."
                  : String(t.val);
            print(`  ${t.cnt.toLocaleString().padStart(9)}  ${valStr}`);
          }
          print("```");
        }
        print();
      }
    }
  }

  // ── 3. Normalization Candidates ──────────────────────────────────────────

  print("## 3. Normalization Candidates");
  print();
  print(
    "Columns with low cardinality, high row count, and >1 MB raw data — where replacing TEXT with an integer FK (1/2/4 bytes based on cardinality) would save space."
  );
  print();

  const normCandidates = findNormalizationCandidates(columnProfiles);
  if (normCandidates.length === 0) {
    print("*No significant normalization candidates found.*");
  } else {
    const normHeaders = [
      "Table",
      "Column",
      "Distinct",
      "Rows",
      "Data (MB)",
      "Saving (MB)",
      "Top values",
    ];
    const normAligns = ["l", "l", "r", "r", "r", "r", "l"];
    const normRows = normCandidates.map((c) => [
      c.table,
      c.column,
      c.distinctVals.toLocaleString(),
      c.nonNull.toLocaleString(),
      fmt(c.dataMB),
      fmt(c.savingsMB),
      c.top3.map((t) => `${t.val}`).join(", "),
    ]);
    print(mdTable(normHeaders, normRows, normAligns));
  }
  print();

  // ── 4. Mappings Integer-Encoding Estimate ────────────────────────────────

  print("## 4. Mappings Integer-Encoding Estimate");
  print();
  const mp = profileMappings(db);

  print(`**Total rows:** ${mp.total.toLocaleString()}`);
  print(`**Distinct object_number:** ${mp.cardinality.distinct_on.toLocaleString()}`);
  print(`**Distinct vocab_id:** ${mp.cardinality.distinct_vid.toLocaleString()}`);
  print(`**Distinct field:** ${mp.cardinality.distinct_field.toLocaleString()}`);
  print();

  print("### Key column sizes");
  print();
  const keyHeaders = ["Column", "Avg Len", "Max Len"];
  const keyAligns = ["l", "r", "r"];
  print(
    mdTable(keyHeaders, [
      ["object_number", fmt(mp.keyStats.avg_on_len), mp.keyStats.max_on_len],
      ["vocab_id", fmt(mp.keyStats.avg_vid_len), mp.keyStats.max_vid_len],
      ["field", fmt(mp.keyStats.avg_field_len), mp.keyStats.max_field_len],
    ], keyAligns)
  );
  print();

  print("### Per-field breakdown");
  print();
  const fieldHeaders = ["Field", "Rows", "Payload (MB)", "% of mappings"];
  const fieldAligns = ["l", "r", "r", "r"];
  const fieldRows = mp.perField.map((f) => [
    f.field,
    f.rows.toLocaleString(),
    fmtMB(f.payload_bytes),
    pct(f.rows, mp.total),
  ]);
  print(mdTable(fieldHeaders, fieldRows, fieldAligns));
  print();

  print("### Integer encoding savings");
  print();
  print(
    `| Metric | Current | ON+VID as INT | All 3 as INT |`
  );
  print(`| --- | ---: | ---: | ---: |`);
  print(
    `| Avg row size (bytes) | ${fmt(mp.currentAvgRow)} | ${fmt(mp.partialIntAvgRow)} | ${fmt(mp.fullIntAvgRow)} |`
  );
  const partialPct = fmt((1 - mp.partialIntAvgRow / mp.currentAvgRow) * 100);
  const fullPct = fmt((1 - mp.fullIntAvgRow / mp.currentAvgRow) * 100);
  print(`| Row size reduction | — | ${partialPct}% | ${fullPct}% |`);
  print();

  // Pre-compute index analysis (needed here and in section 5)
  const idxAnalysis = profileIndexes(db, tableSizes);

  const mappingsDbstat =
    tableSizes.find((r) => r.name === "mappings")?.size_bytes / 1048576.0 || 0;
  const mappingsAutoIdxMB =
    tableSizes.find((r) => r.name === "sqlite_autoindex_mappings_1")?.size_bytes / 1048576.0 || 0;
  const mappingsSecIdxMB = idxAnalysis
    .parsed.filter((i) => i.tbl_name === "mappings")
    .reduce((s, i) => s + i.sizeMB, 0);
  const mappingsAllMB = mappingsDbstat + mappingsAutoIdxMB + mappingsSecIdxMB;
  print(
    `Mappings table: **${fmt(mappingsDbstat)} MB** + PK index: **${fmt(mappingsAutoIdxMB)} MB** + secondary indexes: **${fmt(mappingsSecIdxMB)} MB** = **${fmt(mappingsAllMB)} MB**`
  );
  const tableAndPkRatio = 1 - mp.fullIntAvgRow / mp.currentAvgRow;
  print(
    `Estimated table+PK savings (all 3 INT): **${fmt((mappingsDbstat + mappingsAutoIdxMB) * tableAndPkRatio)} MB** (${fmt(tableAndPkRatio * 100)}% of ${fmt(mappingsDbstat + mappingsAutoIdxMB)} MB)`
  );
  print(
    `Secondary index savings vary per-index (see Strategy Summary for combined total).`
  );
  print();

  // ── 5. Index Redundancy & Runtime Classification ─────────────────────────

  print("## 5. Index Analysis");
  print();

  const idxHeaders = [
    "Index",
    "Table",
    "Columns",
    "Size (MB)",
    "Partial",
    "Classification",
  ];
  const idxAligns = ["l", "l", "l", "r", "l", "l"];
  const idxRows = idxAnalysis.parsed.map((idx) => [
    idx.name,
    idx.tbl_name,
    idx.columns.join(", "),
    fmt(idx.sizeMB),
    idx.isPartial ? "yes" : "",
    idxAnalysis.HARVEST_ONLY.has(idx.name) ? "harvest-only" : "runtime",
  ]);
  print(mdTable(idxHeaders, idxRows, idxAligns));
  print();

  if (idxAnalysis.redundancies.length > 0) {
    print("### Prefix redundancies");
    print();
    for (const r of idxAnalysis.redundancies) {
      print(
        `- **${r.redundant}** (${r.redundantCols.join(", ")}) is a prefix of **${r.coveredBy}** (${r.coveringCols.join(", ")}) → **${fmt(r.savingsMB)} MB** recoverable`
      );
    }
    print();
  } else {
    print("*No prefix redundancies detected.*");
    print();
  }

  // ── 6. Strategy Summary ──────────────────────────────────────────────────

  print("## 6. Strategy Summary");
  print();

  const strategies = buildStrategies(
    sizeMB,
    tableSizes,
    mp,
    idxAnalysis,
    normCandidates,
    columnProfiles
  );

  const stratHeaders = [
    "Strategy",
    "Component",
    "Current (MB)",
    "Savings (MB)",
    "Complexity",
    "Notes",
  ];
  const stratAligns = ["l", "l", "r", "r", "l", "l"];
  const stratRows = strategies.map((s) => [
    s.strategy,
    s.component,
    s.currentMB,
    s.savingsMB,
    s.complexity,
    s.notes,
  ]);
  print(mdTable(stratHeaders, stratRows, stratAligns));
  print();

  const totalSavings = strategies.reduce(
    (s, st) => s + parseFloat(st.savingsMB),
    0
  );
  const projectedSize = sizeMB - totalSavings;
  print(`**Current file size:** ${fmt(sizeMB)} MB (${fmt(sizeMB / 1024, 2)} GB)`);
  print(
    `**Total estimated savings:** ${fmt(totalSavings)} MB (${fmt(totalSavings / 1024, 2)} GB)`
  );
  print(
    `**Projected size:** ${fmt(projectedSize)} MB (${fmt(projectedSize / 1024, 2)} GB)`
  );
  print(
    `**Target:** <2048 MB — ${projectedSize < 2048 ? "**ACHIEVABLE**" : "**NOT YET — need more optimizations**"}`
  );
  print();

  // Print the report
  console.log(out.join("\n"));

  db.close();
}

main();
