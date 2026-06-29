import type { Database as DatabaseType, Statement } from "better-sqlite3";
import {
  formatDateRange,
  LINEAGE_QUALIFIERS,
  RELATED_VARIANT_LABELS,
} from "./VocabularyDb.js";
import type {
  ArtworkMeta,
  IconclassSimilarResult,
  LineageSimilarResult,
  DepictedSimilarResult,
  SharedMotif,
  SharedLineage,
} from "./VocabularyDb.js";

// ─────────────────────────────────────────────────────────────────────────────
// find_similar similarity cluster, extracted from VocabularyDb (plan 047).
//
// Behaviour-preserving move: the 7 findSimilarBy* channels, their 7 lazy IDF
// cache builders, and the shared resolve -> IDF-score -> rank -> hydrate
// helpers. The cluster reaches the rest of VocabularyDb ONLY through
// SimilarityDeps below — it holds no reference to the VocabularyDb instance.
// VocabularyDb keeps thin public forwarders (findSimilarBy*, warmSimilarCaches).
// ─────────────────────────────────────────────────────────────────────────────

/** Iconclass noise labels to exclude — high-frequency categorical artefacts, not iconographic signals. */
const ICONCLASS_NOISE_LABELS = new Set([
  "historical persons",
  "historical persons - BB - woman",
  "adult man",
  "adult woman",
]);

/** Resolve a Wikidata URI from external_id (harvest) or wikidata_id (enrichment). */
function toWikidataUri(row: { external_id: string | null; wikidata_id: string | null }): string | undefined {
  return row.external_id ?? (row.wikidata_id ? `http://www.wikidata.org/entity/${row.wikidata_id}` : undefined);
}

/**
 * The exact (and only) surface the similarity cluster reaches into on
 * VocabularyDb. Every member is a DB handle, a constructor-time flag, or a thin
 * function — none requires a back-reference to the VocabularyDb instance.
 */
export interface SimilarityDeps {
  /** Shared read-only better-sqlite3 handle (the cluster prepares its own statements against it). */
  db: DatabaseType;
  /** assignment_pairs table present (v0.24+) — gates the Lineage channel. */
  hasAssignmentPairs: boolean;
  /** related_objects table present — gates the Related Variant / Related Object channels. */
  hasRelatedObjects: boolean;
  /** field-name -> integer field_id (throws if missing). */
  requireFieldId: (name: string) => number;
  /** field-name presence (the Theme channel no-ops when "theme" is absent). */
  hasField: (name: string) => boolean;
  /** art_id + title + creator_label by object_number (shared stmtLookupArtId). */
  lookupArtRow: (objectNumber: string) => { art_id: number; title: string; creator_label: string } | undefined;
  /** Batch metadata hydration (stays public on VocabularyDb; also used by similar.ts). */
  batchLookupByArtId: (artIds: number[]) => Map<number, ArtworkMeta>;
  batchLookupTypesByArtId: (artIds: number[]) => Map<number, string>;
  batchLookupImportanceByArtId: (artIds: number[]) => Map<number, number>;
}

export class SimilarityQueries {
  constructor(private readonly deps: SimilarityDeps) {}

  // ── deps accessors: preserve the original this.<member> call sites verbatim ──
  private get db(): DatabaseType { return this.deps.db; }
  private get hasAssignmentPairs(): boolean { return this.deps.hasAssignmentPairs; }
  private get hasRelatedObjects_(): boolean { return this.deps.hasRelatedObjects; }
  private requireFieldId(name: string): number { return this.deps.requireFieldId(name); }
  private batchLookupByArtId(artIds: number[]): Map<number, ArtworkMeta> { return this.deps.batchLookupByArtId(artIds); }
  private batchLookupTypesByArtId(artIds: number[]): Map<number, string> { return this.deps.batchLookupTypesByArtId(artIds); }
  private batchLookupImportanceByArtId(artIds: number[]): Map<number, number> { return this.deps.batchLookupImportanceByArtId(artIds); }
  /** Shim preserving the original `this.stmtLookupArtId!.get(objectNumber)` call sites. */
  private readonly stmtLookupArtId = { get: (objectNumber: string) => this.deps.lookupArtRow(objectNumber) };

  // ── cluster-owned statements + lazy IDF caches (built on first call) ──
  private stmtMappingsByFieldVocab: Statement | null = null;
  private notationDf: Map<number, number> | null = null; // vocab_rowid → document frequency
  private iconclassN = 0; // total artworks with any Iconclass notation
  private lineageCreatorDf: Map<string, number> | null = null; // creator vocabulary.id → df
  private lineageN = 0; // total artworks with any visual-lineage qualifier
  private lineageQualifierMap: Map<string, { label: string; strength: number; aatUri: string }> | null = null; // vocabulary.id → info
  private stmtLineageShared: Statement | null = null; // cached: artwork_id by (qualifier_id, creator_id) — assignment_pairs
  private iconclassNoiseIds: Set<number> | null = null; // vocab_rowids to exclude
  private personDf: Map<number, number> | null = null; // person vocab_rowid → document frequency
  private personN = 0; // total artworks with depicted persons
  private placeDf: Map<number, number> | null = null; // place vocab_rowid → document frequency
  private placeN = 0; // total artworks with depicted places (after filtering)
  private placeExcluded: Set<number> | null = null; // vocab_rowids excluded (TGN + broad places)
  private themeDf: Map<number, number> | null = null; // theme vocab_rowid → document frequency
  private themeN = 0; // total artworks with at least one theme
  private relatedVariantByArtId: Map<number, { peerArtId: number; label: string }[]> | null = null;
  private relatedObjectByArtId: Map<number, { peerArtId: number; label: string }[]> | null = null;
  private static readonly RELATED_OBJECT_LABELS = [
    "pair", "pair (weapons)", "set", "recto | verso", "product line",
    "original | reproduction", "related object",
  ] as const;
  private static readonly RELATED_OBJECT_TIER_WEIGHT: Record<string, number> = {
    "pair": 6,
    "pair (weapons)": 6,
    "set": 6,
    "recto | verso": 6,
    "product line": 6,
    "original | reproduction": 4,
    "related object": 2,
  };

  /** Lazily prepare the shared mappings-lookup statement (used by Iconclass, Person, Place signals). */
  private ensureMappingsStmt(): void {
    if (this.stmtMappingsByFieldVocab || !this.db) return;
    this.stmtMappingsByFieldVocab = this.db.prepare(
      `SELECT artwork_id FROM mappings WHERE field_id = ? AND vocab_rowid = ?`
    );
  }

  // ── find_similar: Iconclass overlap ──────────────────────────────────

  /** Lazily initialise the Iconclass IDF cache. ~2s cold, <0.5s warm. */
  private ensureIconclassCache(): void {
    if (this.notationDf || !this.db) return;
    const subjectFieldId = this.requireFieldId("subject");

    // Build noise ID set
    this.iconclassNoiseIds = new Set<number>();
    const noiseRows = this.db.prepare(
      `SELECT vocab_int_id FROM vocabulary WHERE label_en IN (${[...ICONCLASS_NOISE_LABELS].map(() => "?").join(", ")})`
    ).all(...ICONCLASS_NOISE_LABELS) as { vocab_int_id: number }[];
    for (const r of noiseRows) this.iconclassNoiseIds.add(r.vocab_int_id);

    // IDF: count artworks per notation
    this.notationDf = new Map();
    const rows = this.db.prepare(`
      SELECT m.vocab_rowid, COUNT(DISTINCT m.artwork_id) as df
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.field_id = ? AND v.notation IS NOT NULL
      GROUP BY m.vocab_rowid
    `).all(subjectFieldId) as { vocab_rowid: number; df: number }[];

    for (const r of rows) {
      if (this.iconclassNoiseIds.has(r.vocab_rowid)) continue;
      this.notationDf.set(r.vocab_rowid, r.df);
    }
    // Count total unique artworks with Iconclass
    const countRow = this.db.prepare(`
      SELECT COUNT(DISTINCT m.artwork_id) as n
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.field_id = ? AND v.notation IS NOT NULL
    `).get(subjectFieldId) as { n: number };
    this.iconclassN = countRow.n;
    this.ensureMappingsStmt();
    console.error(`[find_similar] Iconclass IDF cache: ${this.notationDf.size} notations, ${this.iconclassN.toLocaleString()} artworks`);
  }

  /**
   * Find artworks similar to a given artwork by shared Iconclass notations.
   * Scores by depth × IDF weighted overlap.
   */
  findSimilarByIconclass(objectNumber: string, maxResults: number): IconclassSimilarResult | null {
    if (!this.db) return null;
    this.ensureIconclassCache();
    if (!this.notationDf) return null;

    const subjectFieldId = this.requireFieldId("subject");

    // 1. Resolve art_id
    const artRow = this.stmtLookupArtId!.get(objectNumber) as { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;
    const queryArtId = artRow.art_id;

    // 2. Get query artwork's Iconclass notations
    const queryNotationsRaw = this.db.prepare(`
      SELECT m.vocab_rowid, v.notation, COALESCE(v.label_en, v.label_nl, '') as label
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.artwork_id = ? AND +m.field_id = ? AND v.notation IS NOT NULL
    `).all(queryArtId, subjectFieldId) as { vocab_rowid: number; notation: string; label: string }[];

    // Filter noise labels
    const queryNotations = queryNotationsRaw.filter(n => !this.iconclassNoiseIds!.has(n.vocab_rowid));
    if (queryNotations.length === 0) {
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow.title || "",
        queryNotations: [],
        results: [],
        warnings: ["This artwork has no Iconclass notations to search by."],
      };
    }

    // 3. For each notation, find candidate artworks and accumulate scores
    const candidates = new Map<number, { totalWeight: number; sharedMotifs: SharedMotif[] }>();

    for (const qn of queryNotations) {
      const depth = qn.notation.length;
      const df = this.notationDf.get(qn.vocab_rowid) ?? 1;
      const weight = depth * Math.log(this.iconclassN / df);
      const motif: SharedMotif = { notation: qn.notation, label: qn.label, weight };

      const rows = this.stmtMappingsByFieldVocab!.all(subjectFieldId, qn.vocab_rowid) as { artwork_id: number }[];
      for (const r of rows) {
        if (r.artwork_id === queryArtId) continue; // exclude self
        const entry = candidates.get(r.artwork_id);
        if (entry) {
          entry.totalWeight += weight;
          entry.sharedMotifs.push(motif);
        } else {
          candidates.set(r.artwork_id, { totalWeight: weight, sharedMotifs: [motif] });
        }
      }
    }

    // 3b. Filter single-notation matches unless the notation is specific (depth ≥ 5)
    const MIN_SOLO_NOTATION_DEPTH = 5;
    for (const [artId, data] of candidates) {
      if (data.sharedMotifs.length === 1 && data.sharedMotifs[0].notation.length < MIN_SOLO_NOTATION_DEPTH) {
        candidates.delete(artId);
      }
    }

    // 4. Sort by totalWeight, take top maxResults
    const sorted = [...candidates.entries()]
      .sort((a, b) => b[1].totalWeight - a[1].totalWeight)
      .slice(0, maxResults);

    // 5. Batch-resolve metadata
    const artIds = sorted.map(([artId]) => artId);
    const metaMap = this.batchLookupByArtId(artIds);
    const typeMap = this.batchLookupTypesByArtId(artIds);

    const results = sorted.map(([artId, data]) => {
      const meta = metaMap.get(artId);
      const date = formatDateRange(meta?.dateEarliest, meta?.dateLatest);
      // Sort shared motifs by weight descending
      data.sharedMotifs.sort((a, b) => b.weight - a.weight);
      return {
        artId,
        objectNumber: meta?.objectNumber ?? `art_id:${artId}`,
        title: meta?.title ?? "",
        creator: meta?.creator ?? "",
        ...(date && { date }),
        ...(typeMap.has(artId) && { type: typeMap.get(artId) }),
        ...(meta?.iiifId && { iiifId: meta.iiifId }),
        score: Math.round(data.totalWeight * 10) / 10, // 1dp — iconclass scores are coarse (depth × IDF)
        sharedMotifs: data.sharedMotifs,
        url: `https://www.rijksmuseum.nl/en/collection/${meta?.objectNumber ?? ""}`,
      };
    });

    return {
      queryObjectNumber: objectNumber,
      queryTitle: artRow.title || "",
      queryNotations: queryNotations.map(n => ({
        notation: n.notation,
        label: n.label,
        depth: n.notation.length,
      })),
      results,
    };
  }

  // ── find_similar: Attribution lineage ──────────────────────────────

  /** Lazily initialise lineage qualifier map and creator IDF cache.
   *  Reads from `assignment_pairs` (v0.24+) — preserves the actual qualifier↔creator
   *  assignment. The pre-v0.24 mappings self-JOIN fabricated cartesian pairs whenever
   *  an artwork had multiple qualifiers AND multiple creators (issue #144). */
  private ensureLineageCache(): void {
    if (this.lineageQualifierMap || !this.db) return;
    if (!this.hasAssignmentPairs) return; // #144: gracefully handled by findSimilarByLineage

    // Resolve AAT URIs → vocabulary.id (TEXT) for lineage qualifiers
    this.lineageQualifierMap = new Map();
    for (const [uri, strength] of LINEAGE_QUALIFIERS) {
      const row = this.db.prepare(
        "SELECT id, COALESCE(label_en, label_nl, '') as label FROM vocabulary WHERE external_id = ?"
      ).get(uri) as { id: string; label: string } | undefined;
      if (row) {
        this.lineageQualifierMap.set(row.id, { label: row.label, strength, aatUri: uri });
      }
    }
    const qualIds = [...this.lineageQualifierMap.keys()];
    if (qualIds.length === 0) return;

    // Creator IDF: for each creator that co-appears with a visual-lineage qualifier
    // on the SAME assignment (not just the same artwork). Uses idx_assignment_pairs_qualifier.
    this.lineageCreatorDf = new Map();
    const placeholders = qualIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT creator_id, COUNT(DISTINCT artwork_id) as df
      FROM assignment_pairs
      WHERE qualifier_id IN (${placeholders})
      GROUP BY creator_id
    `).all(...qualIds) as { creator_id: string; df: number }[];

    for (const r of rows) this.lineageCreatorDf.set(r.creator_id, r.df);

    // Total artworks with any visual-lineage qualifier
    const countRow = this.db.prepare(`
      SELECT COUNT(DISTINCT artwork_id) as n FROM assignment_pairs
      WHERE qualifier_id IN (${placeholders})
    `).get(...qualIds) as { n: number };
    this.lineageN = countRow.n;
    // Cache the per-pair candidate lookup statement (called N times per query).
    // PK is (artwork_id, qualifier_id, creator_id) — each artwork appears at
    // most once per (qualifier_id, creator_id), so no DISTINCT needed.
    this.stmtLineageShared = this.db.prepare(`
      SELECT artwork_id FROM assignment_pairs
      WHERE qualifier_id = ? AND creator_id = ?
    `);
    console.error(`[find_similar] Lineage IDF cache: ${this.lineageCreatorDf.size} creators, ${this.lineageN.toLocaleString()} artworks`);
  }

  /**
   * Find artworks similar to a given artwork by shared visual-style lineage.
   * Scores by qualifier-strength × creator-IDF.
   */
  findSimilarByLineage(objectNumber: string, maxResults: number): LineageSimilarResult | null {
    if (!this.db) return null;
    if (!this.hasAssignmentPairs) {
      // #144: pre-v0.24 DBs lack the assignment_pairs table. Returning a graceful
      // warning is preferable to running the old self-JOIN that fabricated cartesian
      // pairs for multi-attribution artworks.
      const artRow = this.stmtLookupArtId!.get(objectNumber) as { art_id: number; title: string; creator_label: string } | undefined;
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow?.title ?? "",
        queryLineage: [],
        results: [],
        warnings: ["Lineage similarity is not supported on this server."],
      };
    }
    this.ensureLineageCache();
    if (!this.lineageQualifierMap || !this.lineageCreatorDf) return null;

    // 1. Resolve art_id
    const artRow = this.stmtLookupArtId!.get(objectNumber) as { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;
    const queryArtId = artRow.art_id;

    // 2. Get query artwork's actual (qualifier, creator) assignments from v0.24+
    //    assignment_pairs. Only visual-similarity qualifiers (not "primary",
    //    "attributed to", etc.).
    const qualIds = [...this.lineageQualifierMap.keys()];
    const qualPlaceholders = qualIds.map(() => "?").join(", ");

    const queryPairs = this.db.prepare(`
      SELECT ap.qualifier_id, ap.creator_id,
             COALESCE(v.label_en, v.label_nl, '') as creator_label
      FROM assignment_pairs ap
      JOIN vocabulary v ON v.id = ap.creator_id
      WHERE ap.artwork_id = ? AND ap.qualifier_id IN (${qualPlaceholders})
    `).all(queryArtId, ...qualIds) as {
      qualifier_id: string; creator_id: string; creator_label: string;
    }[];

    if (queryPairs.length === 0) {
      // Check if the artwork has any assignment pairs at all (to give an informative message)
      const anyAssignment = this.db.prepare(
        "SELECT 1 FROM assignment_pairs WHERE artwork_id = ? LIMIT 1"
      ).get(queryArtId);
      const msg = anyAssignment
        ? "This artwork has direct attribution — no visual-lineage qualifiers to search by."
        : "No attribution qualifiers found for this artwork.";
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow.title || "",
        queryLineage: [],
        results: [],
        warnings: [msg],
      };
    }

    // 3. For each (qualifier, creator) pair, find candidate artworks
    const candidates = new Map<number, { totalWeight: number; sharedLineage: SharedLineage[] }>();
    const warnings: string[] = [];

    for (const pair of queryPairs) {
      const qualInfo = this.lineageQualifierMap.get(pair.qualifier_id)!;
      const creatorDf = this.lineageCreatorDf.get(pair.creator_id) ?? 1;
      const creatorIdf = Math.log(this.lineageN / creatorDf);
      const weight = qualInfo.strength * creatorIdf;
      const lineage: SharedLineage = {
        qualifierLabel: qualInfo.label,
        qualifierUri: qualInfo.aatUri,
        creatorLabel: pair.creator_label,
        strength: qualInfo.strength,
      };

      // Warn about anonymous/unknown creators with near-zero IDF
      if (creatorIdf < 0.5 && pair.creator_label.toLowerCase().match(/^(anonymous|unknown|onbekend)/)) {
        warnings.push(`"${qualInfo.label} ${pair.creator_label}" — anonymous creator, results may be less distinctive.`);
      }

      // Find artworks sharing this (qualifier, creator) pair
      const rows = this.stmtLineageShared!.all(pair.qualifier_id, pair.creator_id) as { artwork_id: number }[];

      for (const r of rows) {
        if (r.artwork_id === queryArtId) continue;
        const entry = candidates.get(r.artwork_id);
        if (entry) {
          entry.totalWeight += weight;
          entry.sharedLineage.push(lineage);
        } else {
          candidates.set(r.artwork_id, { totalWeight: weight, sharedLineage: [lineage] });
        }
      }
    }

    // 4. Sort by totalWeight, take top maxResults
    const sorted = [...candidates.entries()]
      .sort((a, b) => b[1].totalWeight - a[1].totalWeight)
      .slice(0, maxResults);

    // 5. Batch-resolve metadata
    const artIds = sorted.map(([artId]) => artId);
    const metaMap = this.batchLookupByArtId(artIds);
    const typeMap = this.batchLookupTypesByArtId(artIds);

    const results = sorted.map(([artId, data]) => {
      const meta = metaMap.get(artId);
      const date = formatDateRange(meta?.dateEarliest, meta?.dateLatest);
      data.sharedLineage.sort((a, b) => b.strength - a.strength);
      return {
        artId,
        objectNumber: meta?.objectNumber ?? `art_id:${artId}`,
        title: meta?.title ?? "",
        creator: meta?.creator ?? "",
        ...(date && { date }),
        ...(typeMap.has(artId) && { type: typeMap.get(artId) }),
        ...(meta?.iiifId && { iiifId: meta.iiifId }),
        score: Math.round(data.totalWeight * 100) / 100, // 2dp — lineage IDF values are finer-grained
        sharedLineage: data.sharedLineage,
        url: `https://www.rijksmuseum.nl/en/collection/${meta?.objectNumber ?? ""}`,
      };
    });

    return {
      queryObjectNumber: objectNumber,
      queryTitle: artRow.title || "",
      queryLineage: queryPairs.map(p => {
        const qi = this.lineageQualifierMap!.get(p.qualifier_id)!;
        return { qualifierLabel: qi.label, qualifierUri: qi.aatUri, creatorLabel: p.creator_label, strength: qi.strength };
      }),
      results,
      ...(warnings.length > 0 && { warnings }),
    };
  }

  // ── find_similar: Depicted Person overlap ────────────────────────────

  /** Lazily initialise the depicted person IDF cache. */
  private ensurePersonCache(): void {
    if (this.personDf || !this.db) return;
    const subjectFieldId = this.requireFieldId("subject");

    // IDF: count artworks per depicted person
    this.personDf = new Map();
    const rows = this.db.prepare(`
      SELECT m.vocab_rowid, COUNT(DISTINCT m.artwork_id) as df
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.field_id = ? AND v.type = 'person'
      GROUP BY m.vocab_rowid
    `).all(subjectFieldId) as { vocab_rowid: number; df: number }[];

    for (const r of rows) this.personDf.set(r.vocab_rowid, r.df);

    const countRow = this.db.prepare(`
      SELECT COUNT(DISTINCT m.artwork_id) as n
      FROM mappings m JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.field_id = ? AND v.type = 'person'
    `).get(subjectFieldId) as { n: number };
    this.personN = countRow.n;
    this.ensureMappingsStmt();
    console.error(`[find_similar] Person IDF cache: ${this.personDf.size} persons, ${this.personN.toLocaleString()} artworks`);
  }

  /**
   * Shared implementation for depicted-person and depicted-place similarity.
   * Scores by IDF-weighted overlap of query terms against candidates.
   */
  private findSimilarByDepictedTerms(
    objectNumber: string,
    maxResults: number,
    queryTerms: { vocab_rowid: number; label: string; external_id: string | null; wikidata_id: string | null }[],
    dfMap: Map<number, number>,
    N: number,
    fieldId: number,
    artRow: { art_id: number; title: string },
    emptyWarning: string,
  ): DepictedSimilarResult {
    if (queryTerms.length === 0) {
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow.title || "",
        queryTerms: [],
        results: [],
        warnings: [emptyWarning],
      };
    }

    const queryArtId = artRow.art_id;
    const candidates = new Map<number, { totalWeight: number; sharedTerms: { label: string; weight: number; wikidataUri?: string }[] }>();

    for (const term of queryTerms) {
      const df = dfMap.get(term.vocab_rowid) ?? 1;
      const idf = Math.log(N / df);
      const weight = Math.round(idf * 100) / 100;
      const wikidataUri = toWikidataUri(term);

      const rows = this.stmtMappingsByFieldVocab!.all(fieldId, term.vocab_rowid) as { artwork_id: number }[];
      for (const r of rows) {
        if (r.artwork_id === queryArtId) continue;
        const entry = candidates.get(r.artwork_id);
        if (entry) {
          entry.totalWeight += idf;
          entry.sharedTerms.push({ label: term.label, weight, ...(wikidataUri && { wikidataUri }) });
        } else {
          candidates.set(r.artwork_id, { totalWeight: idf, sharedTerms: [{ label: term.label, weight, ...(wikidataUri && { wikidataUri }) }] });
        }
      }
    }

    const sorted = [...candidates.entries()]
      .sort((a, b) => b[1].totalWeight - a[1].totalWeight)
      .slice(0, maxResults);

    const artIds = sorted.map(([artId]) => artId);
    const metaMap = this.batchLookupByArtId(artIds);
    const typeMap = this.batchLookupTypesByArtId(artIds);

    const results = sorted.map(([artId, data]) => {
      const meta = metaMap.get(artId);
      const date = formatDateRange(meta?.dateEarliest, meta?.dateLatest);
      data.sharedTerms.sort((a, b) => b.weight - a.weight);
      return {
        artId,
        objectNumber: meta?.objectNumber ?? `art_id:${artId}`,
        title: meta?.title ?? "",
        creator: meta?.creator ?? "",
        ...(date && { date }),
        ...(typeMap.has(artId) && { type: typeMap.get(artId) }),
        ...(meta?.iiifId && { iiifId: meta.iiifId }),
        score: Math.round(data.totalWeight * 100) / 100,
        sharedTerms: data.sharedTerms,
        url: `https://www.rijksmuseum.nl/en/collection/${meta?.objectNumber ?? ""}`,
      };
    });

    return {
      queryObjectNumber: objectNumber,
      queryTitle: artRow.title || "",
      queryTerms: queryTerms.map(t => {
        const wikidataUri = toWikidataUri(t);
        return { label: t.label, artworks: dfMap.get(t.vocab_rowid) ?? 0, ...(wikidataUri && { wikidataUri }) };
      }),
      results,
    };
  }

  /**
   * Find artworks similar to a given artwork by shared depicted persons.
   * Scores by IDF-weighted overlap.
   */
  findSimilarByDepictedPerson(objectNumber: string, maxResults: number): DepictedSimilarResult | null {
    if (!this.db) return null;
    this.ensurePersonCache();
    if (!this.personDf) return null;

    const subjectFieldId = this.requireFieldId("subject");
    const artRow = this.stmtLookupArtId!.get(objectNumber) as { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;

    const queryPersons = this.db.prepare(`
      SELECT m.vocab_rowid, COALESCE(v.label_en, v.label_nl, '') as label,
             v.external_id, v.wikidata_id
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.artwork_id = ? AND +m.field_id = ? AND v.type = 'person'
    `).all(artRow.art_id, subjectFieldId) as { vocab_rowid: number; label: string; external_id: string | null; wikidata_id: string | null }[];

    return this.findSimilarByDepictedTerms(
      objectNumber, maxResults, queryPersons,
      this.personDf, this.personN, subjectFieldId, artRow,
      "This artwork has no depicted persons to search by.",
    );
  }

  // ── find_similar: Depicted Place overlap ─────────────────────────────

  /** Maximum children count for a place to be included as a depicted-place signal. */
  private static readonly PLACE_CHILDREN_THRESHOLD = 20;

  /** Lazily initialise the depicted place IDF cache with breadth-based filtering. */
  private ensurePlaceCache(): void {
    if (this.placeDf || !this.db) return;
    const subjectFieldId = this.requireFieldId("subject");

    // Exclude broad regions (>20 children in vocabulary hierarchy).
    // TGN-linked places are NOT blanket-excluded — only genuinely broad ones.
    this.placeExcluded = new Set<number>();

    const broadRows = this.db.prepare(`
      SELECT v.vocab_int_id
      FROM vocabulary v
      JOIN (
        SELECT broader_id, COUNT(*) as child_count
        FROM vocabulary WHERE broader_id IS NOT NULL
        GROUP BY broader_id
      ) cc ON cc.broader_id = v.id
      WHERE v.type = 'place' AND cc.child_count > ?
    `).all(SimilarityQueries.PLACE_CHILDREN_THRESHOLD) as { vocab_int_id: number }[];
    for (const r of broadRows) this.placeExcluded.add(r.vocab_int_id);

    // IDF: count artworks per depicted place (excluding noise)
    this.placeDf = new Map();
    const rows = this.db.prepare(`
      SELECT m.vocab_rowid, COUNT(DISTINCT m.artwork_id) as df
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.field_id = ? AND v.type = 'place'
      GROUP BY m.vocab_rowid
    `).all(subjectFieldId) as { vocab_rowid: number; df: number }[];

    for (const r of rows) {
      if (this.placeExcluded.has(r.vocab_rowid)) continue;
      this.placeDf.set(r.vocab_rowid, r.df);
    }

    // Count distinct artworks with at least one non-excluded place.
    // We can't sum DFs (artworks have multiple places), so query with a temp table.
    this.db.exec("CREATE TEMP TABLE IF NOT EXISTS _place_vocab_ids (id INTEGER PRIMARY KEY)");
    this.db.exec("DELETE FROM _place_vocab_ids");
    const insertStmt = this.db.prepare("INSERT INTO _place_vocab_ids (id) VALUES (?)");
    const insertMany = this.db.transaction((ids: number[]) => { for (const id of ids) insertStmt.run(id); });
    insertMany([...this.placeDf.keys()]);
    const countRow = this.db.prepare(`
      SELECT COUNT(DISTINCT m.artwork_id) as n
      FROM mappings m
      WHERE m.field_id = ? AND m.vocab_rowid IN (SELECT id FROM _place_vocab_ids)
    `).get(subjectFieldId) as { n: number };
    this.placeN = countRow.n;
    this.db.exec("DROP TABLE IF EXISTS _place_vocab_ids");

    this.ensureMappingsStmt();
    console.error(`[find_similar] Place IDF cache: ${this.placeDf.size} places (${this.placeExcluded.size} excluded), ${this.placeN.toLocaleString()} artworks`);
  }

  /**
   * Find artworks similar to a given artwork by shared depicted places.
   * Scores by IDF-weighted overlap. Excludes broad regions (>20 children in hierarchy).
   */
  findSimilarByDepictedPlace(objectNumber: string, maxResults: number): DepictedSimilarResult | null {
    if (!this.db) return null;
    this.ensurePlaceCache();
    if (!this.placeDf) return null;

    const subjectFieldId = this.requireFieldId("subject");
    const artRow = this.stmtLookupArtId!.get(objectNumber) as { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;

    const queryPlacesRaw = this.db.prepare(`
      SELECT m.vocab_rowid, COALESCE(v.label_en, v.label_nl, '') as label,
             v.external_id, v.wikidata_id
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.artwork_id = ? AND +m.field_id = ? AND v.type = 'place'
    `).all(artRow.art_id, subjectFieldId) as { vocab_rowid: number; label: string; external_id: string | null; wikidata_id: string | null }[];

    const queryPlaces = queryPlacesRaw.filter(p => !this.placeExcluded!.has(p.vocab_rowid));

    const emptyWarning = queryPlacesRaw.length > 0
      ? "This artwork's depicted places are too broad (countries/regions) to search by."
      : "This artwork has no depicted places to search by.";

    return this.findSimilarByDepictedTerms(
      objectNumber, maxResults, queryPlaces,
      this.placeDf, this.placeN, subjectFieldId, artRow,
      emptyWarning,
    );
  }

  // ── find_similar: Theme overlap (#294) ───────────────────────────────

  /** Lazily initialise the theme IDF cache. */
  private ensureThemeCache(): void {
    if (this.themeDf || !this.db) return;
    if (!this.deps.hasField("theme")) {
      this.themeDf = new Map();
      return;
    }
    const themeFieldId = this.requireFieldId("theme");

    this.themeDf = new Map();
    const rows = this.db.prepare(`
      SELECT vocab_rowid, COUNT(DISTINCT artwork_id) as df
      FROM mappings WHERE field_id = ?
      GROUP BY vocab_rowid
    `).all(themeFieldId) as { vocab_rowid: number; df: number }[];
    for (const r of rows) this.themeDf.set(r.vocab_rowid, r.df);

    const countRow = this.db.prepare(
      `SELECT COUNT(DISTINCT artwork_id) as n FROM mappings WHERE field_id = ?`
    ).get(themeFieldId) as { n: number };
    this.themeN = countRow.n;
    this.ensureMappingsStmt();
    console.error(`[find_similar] Theme IDF cache: ${this.themeDf.size} themes, ${this.themeN.toLocaleString()} artworks`);
  }

  /**
   * Find artworks similar to a given artwork by shared themes.
   * IDF set-overlap: Σ log(N/DF(t)) over shared themes.
   * Requires the seed to carry ≥2 themes; tertiary tie-break by artworks.importance.
   * Themes do not carry Wikidata identifiers, so sharedTerms[] omits wikidataUri.
   */
  findSimilarByTheme(objectNumber: string, maxResults: number): DepictedSimilarResult | null {
    if (!this.db) return null;
    this.ensureThemeCache();
    if (!this.themeDf) return null;
    if (!this.deps.hasField("theme")) return null;

    const themeFieldId = this.requireFieldId("theme");
    const artRow = this.stmtLookupArtId!.get(objectNumber) as
      { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;

    const queryThemes = this.db.prepare(`
      SELECT m.vocab_rowid, COALESCE(v.label_en, v.label_nl, '') as label
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.artwork_id = ? AND +m.field_id = ?
    `).all(artRow.art_id, themeFieldId) as { vocab_rowid: number; label: string }[];

    if (queryThemes.length < 2) {
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow.title || "",
        queryTerms: queryThemes.map(t => ({
          label: t.label,
          artworks: this.themeDf!.get(t.vocab_rowid) ?? 0,
        })),
        results: [],
        warnings: ["This artwork has fewer than 2 themes — Theme channel requires ≥2 to suppress noise."],
      };
    }

    const queryArtId = artRow.art_id;
    const candidates = new Map<number, { totalWeight: number; sharedTerms: { label: string; weight: number }[] }>();

    for (const term of queryThemes) {
      const df = this.themeDf.get(term.vocab_rowid) ?? 1;
      const idf = Math.log(this.themeN / df);
      const weight = Math.round(idf * 100) / 100;

      const rows = this.stmtMappingsByFieldVocab!.all(themeFieldId, term.vocab_rowid) as { artwork_id: number }[];
      for (const r of rows) {
        if (r.artwork_id === queryArtId) continue;
        const entry = candidates.get(r.artwork_id);
        if (entry) {
          entry.totalWeight += idf;
          entry.sharedTerms.push({ label: term.label, weight });
        } else {
          candidates.set(r.artwork_id, { totalWeight: idf, sharedTerms: [{ label: term.label, weight }] });
        }
      }
    }

    const allCandidates = [...candidates.entries()];
    const importanceMap = this.batchLookupImportanceByArtId(allCandidates.map(([artId]) => artId));

    const sorted = allCandidates
      .sort((a, b) => {
        if (b[1].totalWeight !== a[1].totalWeight) return b[1].totalWeight - a[1].totalWeight;
        return (importanceMap.get(b[0]) ?? 0) - (importanceMap.get(a[0]) ?? 0);
      })
      .slice(0, maxResults);

    const artIds = sorted.map(([artId]) => artId);
    const metaMap = this.batchLookupByArtId(artIds);
    const typeMap = this.batchLookupTypesByArtId(artIds);

    const results = sorted.map(([artId, data]) => {
      const meta = metaMap.get(artId);
      const date = formatDateRange(meta?.dateEarliest, meta?.dateLatest);
      data.sharedTerms.sort((a, b) => b.weight - a.weight);
      return {
        artId,
        objectNumber: meta?.objectNumber ?? `art_id:${artId}`,
        title: meta?.title ?? "",
        creator: meta?.creator ?? "",
        ...(date && { date }),
        ...(typeMap.has(artId) && { type: typeMap.get(artId) }),
        ...(meta?.iiifId && { iiifId: meta.iiifId }),
        score: Math.round(data.totalWeight * 100) / 100,
        sharedTerms: data.sharedTerms,
        url: `https://www.rijksmuseum.nl/en/collection/${meta?.objectNumber ?? ""}`,
      };
    });

    return {
      queryObjectNumber: objectNumber,
      queryTitle: artRow.title || "",
      queryTerms: queryThemes.map(t => ({
        label: t.label,
        artworks: this.themeDf!.get(t.vocab_rowid) ?? 0,
      })),
      results,
    };
  }

  // ── find_similar: Related Variant curator-declared edges (#293) ───────

  /**
   * Build a Map<art_id, [{peerArtId, label}]> by scanning related_objects for
   * edges whose relationship_en sits in `labels`. Edges with NULL
   * related_art_id (peer not in our DB) are skipped — the v0.26 dataset has
   * zero such rows in either label scope, so an "external peer" placeholder
   * isn't rendered.
   *
   * Shared by ensureRelatedVariantCache (3 creator-invariant types) and
   * ensureRelatedObjectCache (7 derivative + grouping types).
   */
  private buildRelationshipCache(
    labels: ReadonlyArray<string>,
    logName: string,
  ): Map<number, { peerArtId: number; label: string }[]> {
    const cache = new Map<number, { peerArtId: number; label: string }[]>();
    if (!this.db || !this.hasRelatedObjects_) return cache;

    const placeholders = labels.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT art_id, related_art_id, relationship_en
      FROM related_objects
      WHERE relationship_en IN (${placeholders}) AND related_art_id IS NOT NULL
    `).all(...labels) as {
      art_id: number; related_art_id: number; relationship_en: string;
    }[];

    for (const r of rows) {
      const list = cache.get(r.art_id) ?? [];
      list.push({ peerArtId: r.related_art_id, label: r.relationship_en });
      cache.set(r.art_id, list);
    }
    console.error(`[find_similar] ${logName} cache: ${cache.size} seeds, ${rows.length} edges`);
    return cache;
  }

  private ensureRelatedVariantCache(): void {
    if (this.relatedVariantByArtId || !this.db) return;
    this.relatedVariantByArtId = this.buildRelationshipCache(
      RELATED_VARIANT_LABELS, "Related Variant",
    );
  }

  private ensureRelatedObjectCache(): void {
    if (this.relatedObjectByArtId || !this.db) return;
    this.relatedObjectByArtId = this.buildRelationshipCache(
      SimilarityQueries.RELATED_OBJECT_LABELS, "Related Object",
    );
  }

  /**
   * Find artworks declared as related-variants of the seed via curator-asserted
   * edges ('different example' / 'production stadia' / 'pendant'). Score is
   * fixed at 10 — these are explicit assertions, not probabilistic matches.
   * Multi-label collisions on the same peer collapse into one result whose
   * sharedTerms[] carries every label.
   */
  findSimilarByRelatedVariant(objectNumber: string, maxResults: number): DepictedSimilarResult | null {
    if (!this.db) return null;
    this.ensureRelatedVariantCache();
    if (!this.relatedVariantByArtId) return null;

    const artRow = this.stmtLookupArtId!.get(objectNumber) as
      { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;

    const edges = this.relatedVariantByArtId.get(artRow.art_id) ?? [];
    if (edges.length === 0) {
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow.title || "",
        queryTerms: [],
        results: [],
        warnings: ["No declared related-variant edges (different example / production stadia / pendant) on this artwork."],
      };
    }

    return this.assembleRelatedResults(objectNumber, artRow.title, edges, maxResults, () => 10);
  }

  /**
   * Find artworks declared as Related Objects of the seed — derivative works
   * (original | reproduction, related object) and multi-object groupings
   * (pair / pair (weapons) / set / recto | verso / product line). Score is
   * tiered per relationship type (RELATED_OBJECT_TIER_WEIGHT). When a peer
   * has multiple edges to the seed, the highest tier wins for the score and
   * sharedTerms[] carries every label.
   */
  findSimilarByRelatedObject(objectNumber: string, maxResults: number): DepictedSimilarResult | null {
    if (!this.db) return null;
    this.ensureRelatedObjectCache();
    if (!this.relatedObjectByArtId) return null;

    const artRow = this.stmtLookupArtId!.get(objectNumber) as
      { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;

    const edges = this.relatedObjectByArtId.get(artRow.art_id) ?? [];
    if (edges.length === 0) {
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow.title || "",
        queryTerms: [],
        results: [],
        warnings: ["No declared Related Object edges (pair / set / recto | verso / reproduction / general related object / …) on this artwork."],
      };
    }

    return this.assembleRelatedResults(
      objectNumber, artRow.title, edges, maxResults,
      labels => Math.max(...labels.map(l => SimilarityQueries.RELATED_OBJECT_TIER_WEIGHT[l] ?? 1)),
    );
  }

  /** Shared assembly path for both Related Variant and Related Object channels.
   *  scoreFn receives the distinct labels for a peer and returns the score. */
  private assembleRelatedResults(
    objectNumber: string,
    queryTitle: string,
    edges: { peerArtId: number; label: string }[],
    maxResults: number,
    scoreFn: (labels: string[]) => number,
  ): DepictedSimilarResult {
    const byPeer = new Map<number, Set<string>>();
    for (const e of edges) {
      const labels = byPeer.get(e.peerArtId);
      if (labels) labels.add(e.label);
      else byPeer.set(e.peerArtId, new Set([e.label]));
    }

    const peerIds = [...byPeer.keys()].slice(0, maxResults);
    const metaMap = this.batchLookupByArtId(peerIds);
    const typeMap = this.batchLookupTypesByArtId(peerIds);

    const results = peerIds.map(peerArtId => {
      const labels = [...(byPeer.get(peerArtId) ?? new Set<string>())];
      const meta = metaMap.get(peerArtId);
      const date = formatDateRange(meta?.dateEarliest, meta?.dateLatest);
      const score = scoreFn(labels);
      return {
        artId: peerArtId,
        objectNumber: meta?.objectNumber ?? `art_id:${peerArtId}`,
        title: meta?.title ?? "",
        creator: meta?.creator ?? "",
        ...(date && { date }),
        ...(typeMap.has(peerArtId) && { type: typeMap.get(peerArtId) }),
        ...(meta?.iiifId && { iiifId: meta.iiifId }),
        score,
        sharedTerms: labels.map(label => ({ label, weight: score })),
        url: `https://www.rijksmuseum.nl/en/collection/${meta?.objectNumber ?? ""}`,
      };
    });

    const distinctLabels = [...new Set(edges.map(e => e.label))];
    return {
      queryObjectNumber: objectNumber,
      queryTitle: queryTitle || "",
      queryTerms: distinctLabels.map(label => ({ label, artworks: 0 })),
      results,
    };
  }

  /** Eagerly build all caches used by find_similar.
   *  Safe to call multiple times — each ensure* method no-ops if already built. */
  warmAll(): void {
    if (!this.db) return;
    this.ensureIconclassCache();
    this.ensureLineageCache();
    this.ensurePersonCache();
    this.ensurePlaceCache();
    this.ensureThemeCache();
    this.ensureRelatedVariantCache();
    this.ensureRelatedObjectCache();
  }
}
