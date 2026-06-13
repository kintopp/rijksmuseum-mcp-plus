/**
 * Rule-based parser for Rijksmuseum `artworks.inscription_text`.
 *
 * The field is a `|`-delimited list of segments. Each physical mark is usually
 * recorded twice — a Dutch form carrying full cataloguing detail and an English
 * gloss:
 *
 *   verzamelaarsmerk, verso, gestempeld: Lugt 2228 | collector's mark: Lugt 2228
 *   └── type ──────┘ └loc─┘ └method──┘  └ text ┘     └ Eng. type ──┘  └ text ┘
 *
 * A segment is `<header>: <value>`, where `<header>` is `type` followed by a
 * variable-length, any-order run of placement/technique qualifiers (Dutch side
 * only). The field does NOT honour a fixed `type, location, technique` slotting
 * (see R5 in issue #383) — qualifiers are classified by *vocabulary membership*,
 * with an explicit residue bucket for unrecognised tokens.
 *
 * This module is the single source of truth for the inscription facet vocabulary.
 * The forward maps (surface token → normalised bucket) drive parsing; the inverse
 * maps (bucket → surface tokens) drive FTS candidate expansion in
 * `search_inscriptions` and boilerplate recognition in
 * `formatInscriptionsForEmbedding`. The parser-residue diagnostic reads the same
 * maps so "clean enough" is always measured against the shipping vocabulary.
 *
 * Design notes folded in from issue #383:
 *   R3 — `language` is inferred only from which vocabulary the type/qualifier
 *        tokens came from; value-only / Lugt-only segments are legitimately
 *        "unknown".
 *   R5 — qualifier run is vocabulary-classified, not positional; residue bucket.
 *   R6 — result-layer dedup identity = normalised transcribed value (or type +
 *        collector number for value-less marks); placement/technique are merge
 *        payload, never identity.
 *   R6a — preserve physical multiplicity: one logical match carries an
 *        `occurrences[]`; occurrences derive only from placement-bearing
 *        (qualified) variants, unqualified glosses fold in as a language label.
 */

// ─── Public shape ──────────────────────────────────────────────────

/** A single parsed inscription segment. Lossless: raw is always preserved. */
export interface ParsedInscription {
  sequence: number;
  raw: string;
  language: "nl" | "en" | "unknown";
  /** Raw type token (first comma-field of the header). */
  type: string | null;
  /** Canonical type bucket, or null when the type token is unrecognised. */
  normalizedType: string | null;
  /** Raw placement qualifier text as found (e.g. "verso linksonder"). */
  placement: string | null;
  /** Coarse surface bucket: "recto" | "verso" | null. */
  normalizedPlacement: string | null;
  /** Raw technique qualifier text as found (e.g. "gestempeld"). */
  technique: string | null;
  /** Canonical technique bucket (e.g. "stamped"), or null. */
  normalizedTechnique: string | null;
  /** Raw post-colon text (null when the segment has no colon / empty value). */
  value: string | null;
  /** Quoted strings only — what is actually transcribed *on* the work. */
  transcribedText: string[];
  /** Collector-mark catalogue references found in the value (Lugt N). */
  collectorMarks: { catalogue: string; number: string }[];
  /** R5 residue: header comma-fields that matched no known qualifier vocabulary. */
  unknownQualifiers: string[];
  /** True when the segment is (or carries) a collector mark. */
  isCollectorMark: boolean;
  /** True for type-label-only rows with no value/quote/mark (e.g. `datum | date`). */
  isPlaceholder: boolean;
}

/** Per-artwork rollup over the parsed segments. */
export interface InscriptionSummary {
  hasTranscribedText: boolean;
  hasCollectorMarkOnly: boolean;
  collectorMarks: string[];
  types: string[];
  placements: string[];
  techniques: string[];
}

/** One logical match in `search_inscriptions` results (gloss-deduped, R6/R6a). */
export interface InscriptionMatch {
  normalizedType: string | null;
  /** Normalised transcribed value (null for value-less marks). */
  value: string | null;
  collectorMark?: { catalogue: string; number: string };
  /** One per distinct physical mark; never includes phantom null-gloss rows. */
  occurrences: { placement: string | null; technique: string | null; language: string }[];
  /** Underlying segments — honest provenance of the match. */
  raw: string[];
}

// ─── Facet vocabulary (single source of truth) ─────────────────────
// Each bucket lists its Dutch and English surface forms. Ported from the
// validated maps in scripts/build-inscription-report.py and kept in sync.

interface BucketDef {
  bucket: string;
  nl: string[];
  en: string[];
}

const TYPE_BUCKETS: BucketDef[] = [
  { bucket: "collector's mark", nl: ["verzamelaarsmerk"], en: ["collector's mark"] },
  { bucket: "signature and date", nl: ["signatuur en datum"], en: ["signature and date"] },
  { bucket: "signature", nl: ["signatuur"], en: ["signature"] },
  { bucket: "date", nl: ["datum", "datering"], en: ["date"] },
  { bucket: "inscription", nl: ["opschrift", "inscriptie"], en: ["inscription"] },
  { bucket: "annotation", nl: ["annotatie"], en: ["annotation"] },
  { bucket: "number", nl: ["nummer"], en: ["number"] },
  { bucket: "blind stamp", nl: ["blindstempel"], en: ["blind stamp"] },
  { bucket: "workshop stamp", nl: ["atelierstempel"], en: ["workshop stamp"] },
  { bucket: "check stamp", nl: ["controlestempel", "keurstempel"], en: ["check stamp"] },
  { bucket: "factory mark", nl: ["fabrieksmerk"], en: ["factory mark"] },
  { bucket: "printer's mark", nl: ["drukkersmerk"], en: ["printer's mark"] },
  { bucket: "postmark", nl: ["poststempel"], en: ["postmark"] },
  { bucket: "postage stamp", nl: ["postzegel"], en: ["postage stamp"] },
  { bucket: "stamp", nl: ["stempel"], en: ["stamp"] },
  { bucket: "caption", nl: ["onderschrift"], en: ["caption"] },
  { bucket: "address", nl: ["adres"], en: ["address"] },
  { bucket: "monogram", nl: ["monogram"], en: ["monogram"] },
  { bucket: "watermark", nl: ["watermerk"], en: ["watermark"] },
  { bucket: "mark", nl: ["merk"], en: ["mark"] },
  { bucket: "title", nl: ["titel"], en: ["title"] },
  { bucket: "label", nl: ["etiket"], en: ["label"] },
  { bucket: "name", nl: ["naam"], en: ["name"] },
  { bucket: "text", nl: ["tekst"], en: ["text"] },
  { bucket: "edition", nl: ["oplage"], en: ["edition"] },
  { bucket: "colour note", nl: ["kleurnotitie"], en: ["colour note", "color note"] },
  { bucket: "price", nl: ["prijs"], en: ["price"] },
  // High-frequency types surfaced by the R7 residue diagnostic (issue #383).
  { bucket: "maker's mark", nl: ["meesterteken"], en: ["maker's mark"] },
  { bucket: "seal", nl: ["zegel"], en: ["seal"] },
  { bucket: "circumscription", nl: ["omschrift"], en: ["circumscription"] },
  { bucket: "alloy mark", nl: ["gehalteteken"], en: ["alloy mark"] },
  { bucket: "town mark", nl: ["stadskeur"], en: ["town mark"] },
  { bucket: "date letter", nl: ["jaarletter"], en: ["date letter"] },
  { bucket: "initials", nl: ["initialen"], en: ["initials"] },
  { bucket: "dedication", nl: ["opdracht"], en: ["dedication"] },
  { bucket: "retailer's mark", nl: ["winkeliersmerk"], en: ["retailer's mark"] },
  { bucket: "negative number", nl: ["negatiefnummer"], en: ["negative number"] },
  { bucket: "copyright notice", nl: ["copyrightvermelding"], en: ["copyright notice"] },
  { bucket: "patent notice", nl: ["octrooivermelding"], en: ["patent notice"] },
  { bucket: "monogram and date", nl: ["monogram en datum"], en: ["monogram and date"] },
  { bucket: "date and inscription", nl: ["datum en annotatie", "datum en inscriptie"], en: ["date and inscription"] },
  { bucket: "cliché instruction", nl: ["clichéaanwijzing"], en: ["cliché instruction"] },
  { bucket: "coat of arms", nl: ["wapen (heraldiek)", "wapen"], en: ["coat of arms"] },
  { bucket: "duty mark", nl: ["belastingteken"], en: ["duty mark"] },
  { bucket: "bookplate", nl: ["ex libris"], en: ["bookplate"] },
  { bucket: "mould mark", nl: ["vormersmerk"], en: ["mold mark", "mould mark"] },
  { bucket: "company name", nl: ["firmanaam"], en: ["company name"] },
  { bucket: "serial number", nl: ["serienummer"], en: ["serial number"] },
];

const TECHNIQUE_BUCKETS: BucketDef[] = [
  { bucket: "stamped", nl: ["gestempeld"], en: ["stamped"] },
  { bucket: "handwritten", nl: ["handgeschreven", "handschrift"], en: ["handwritten"] },
  { bucket: "written", nl: ["geschreven"], en: ["written"] },
  { bucket: "printed", nl: ["gedrukt", "geprent", "afgedrukt", "drukken", "meegedrukt"], en: ["printed"] },
  { bucket: "engraved", nl: ["gegraveerd", "graveren"], en: ["engraved"] },
  { bucket: "etched", nl: ["geëtst", "geetst"], en: ["etched"] },
  { bucket: "pencil", nl: ["potlood"], en: ["pencil"] },
  { bucket: "ink", nl: ["inkt"], en: ["ink"] },
  { bucket: "pen", nl: ["pen"], en: ["pen"] },
  { bucket: "chalk", nl: ["krijt"], en: ["chalk"] },
  { bucket: "blind-embossed", nl: ["blinddruk"], en: ["blind-embossed"] },
  { bucket: "painted", nl: ["geschilderd"], en: ["painted"] },
  { bucket: "affixed", nl: ["geplakt"], en: ["affixed"] },
  { bucket: "cut", nl: ["gesneden"], en: ["cut"] },
  { bucket: "scratched", nl: ["gekrast"], en: ["scratched"] },
  // High-frequency techniques surfaced by the R7 residue diagnostic.
  { bucket: "embossed", nl: ["gepreegd"], en: ["embossed"] },
  { bucket: "struck", nl: ["afgeslagen", "geslagen"], en: ["struck"] },
  { bucket: "incised", nl: ["ingegrift", "gegrift"], en: ["incised"] },
  { bucket: "typed", nl: ["getypt", "typeschrift"], en: ["typed"] },
  { bucket: "letterpress", nl: ["boekdruk"], en: ["letterpress"] },
  { bucket: "embroidered", nl: ["geborduurd", "borduren"], en: ["embroidered"] },
  { bucket: "relief", nl: ["reliëf", "reliëfdruk"], en: ["relief"] },
];

// Surface (recto/verso) is the load-bearing placement signal (~90% of placement
// detail). Finer position qualifiers are recognised so they don't fall into the
// residue bucket, but they are preserved in the raw `placement` string rather
// than promoted to a normalised value.
const PLACEMENT_BUCKETS: BucketDef[] = [
  { bucket: "recto", nl: ["recto", "voorzijde"], en: ["recto", "obverse"] },
  { bucket: "verso", nl: ["verso", "achterzijde", "keerzijde"], en: ["verso", "reverse"] },
];

// Position qualifiers — recognised (so non-residue) but not promoted to the
// normalised recto/verso surface. Split by language so they feed the R3
// language inference correctly.
const POSITION_TOKENS_NL = [
  // Dutch corners / centres / edges
  "linksboven", "rechtsboven", "linksonder", "rechtsonder",
  "middenboven", "middenonder", "midden boven", "midden onder",
  "midden", "boven", "onder", "linksmidden", "rechtsmidden", "links", "rechts",
  "bovenregel", "onderregel", "bovenaan", "onderaan",
  "rand", "marge", "hoek", "passe-partout", "opzetvel", "opzetblad", "schutblad", "lijst",
  // Dutch object-sides (recto/verso surfaces themselves live in PLACEMENT_BUCKETS)
  "onderzijde", "bovenzijde", "binnenzijde", "buitenzijde",
];
// English-side direction words (R5: the EN gloss occasionally carries placement).
const POSITION_TOKENS_EN = [
  "bottom", "top", "lower", "upper", "centre", "center", "middle",
  "left", "right", "margin", "edge", "corner",
];

// ─── Derived lookup structures (built once at module load) ──────────

type Lang = "nl" | "en";

interface SurfaceEntry {
  bucket: string;
  langs: Set<Lang>;
}

function buildForward(defs: BucketDef[]): Map<string, SurfaceEntry> {
  const map = new Map<string, SurfaceEntry>();
  for (const def of defs) {
    for (const [lang, forms] of [["nl", def.nl], ["en", def.en]] as [Lang, string[]][]) {
      for (const form of forms) {
        const key = form.toLowerCase();
        const existing = map.get(key);
        if (existing) existing.langs.add(lang);
        else map.set(key, { bucket: def.bucket, langs: new Set([lang]) });
      }
    }
  }
  return map;
}

const TYPE_FORWARD = buildForward(TYPE_BUCKETS);
const TECHNIQUE_FORWARD = buildForward(TECHNIQUE_BUCKETS);
const PLACEMENT_FORWARD = buildForward(PLACEMENT_BUCKETS);

/**
 * Inverse maps (normalised bucket → surface tokens), exported for Stage-A FTS
 * expansion in `search_inscriptions` and boilerplate recognition in
 * `formatInscriptionsForEmbedding`. Written once, three consumers (R2/R5).
 */
function buildInverse(defs: BucketDef[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const def of defs) {
    map.set(def.bucket, [...new Set([...def.nl, ...def.en])]);
  }
  return map;
}

export const INSCRIPTION_TYPE_TOKENS = buildInverse(TYPE_BUCKETS);
export const INSCRIPTION_TECHNIQUE_TOKENS = buildInverse(TECHNIQUE_BUCKETS);
export const INSCRIPTION_PLACEMENT_TOKENS = buildInverse(PLACEMENT_BUCKETS);

/** The closed set of normalised facet values — the tool's public contract. */
export const INSCRIPTION_TYPES = TYPE_BUCKETS.map((d) => d.bucket);
export const INSCRIPTION_TECHNIQUES = TECHNIQUE_BUCKETS.map((d) => d.bucket);
export const INSCRIPTION_PLACEMENTS = PLACEMENT_BUCKETS.map((d) => d.bucket);

// ─── Regexes ───────────────────────────────────────────────────────

// Lugt collector-mark catalogue references (e.g. "Lugt 2228", "Lugt 800a").
const LUGT_RE = /\bLugt\s*(\d+[a-z]?)\b/gi;
// Quoted transcription delimiters: curly ‘…’ and straight "…". Straight single
// quotes are NOT delimiters — they occur inside transcribed text (apostrophes,
// the Dutch "'s" genitive), so the curly class must close only on ’, never on ' —
// otherwise a transcription like ‘pies d'Okayama’ truncates at the apostrophe.
const QUOTE_RES = [/‘([^’]*)’/g, /"([^"]*)"/g];

// ─── HTML entity decode (the handful that leak through, ~0.1%) ──────

const HTML_ENTITIES: Record<string, string> = {
  "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&apos;": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:lt|gt|amp|quot|apos|#39);/g, (m) => HTML_ENTITIES[m] ?? m);
}

// ─── Qualifier matchers (precompiled once) ─────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/** Whole-word match (Unicode-letter boundaries), built once per surface form. */
function wordRe(tok: string): RegExp {
  return new RegExp(`(^|[^a-zà-öø-ÿ])${escapeRe(tok)}($|[^a-zà-öø-ÿ])`, "i");
}

interface QualMatcher {
  re: RegExp;
  bucket: string | null; // normalised surface/technique bucket; null for positions
  langs: Set<Lang>;
}

const SURFACE_MATCHERS: QualMatcher[] = [...PLACEMENT_FORWARD.entries()]
  .map(([form, entry]) => ({ re: wordRe(form), bucket: entry.bucket, langs: entry.langs }));
const TECHNIQUE_MATCHERS: QualMatcher[] = [...TECHNIQUE_FORWARD.entries()]
  .map(([form, entry]) => ({ re: wordRe(form), bucket: entry.bucket, langs: entry.langs }));
const POSITION_MATCHERS: QualMatcher[] = [
  ...POSITION_TOKENS_NL.map((t) => ({ re: wordRe(t), bucket: null, langs: new Set<Lang>(["nl"]) })),
  ...POSITION_TOKENS_EN.map((t) => ({ re: wordRe(t), bucket: null, langs: new Set<Lang>(["en"]) })),
].sort((a, b) => b.re.source.length - a.re.source.length);

interface FieldClass {
  recognised: boolean;
  surfaceBucket: string | null;
  techBucket: string | null;
  nl: boolean;
  en: boolean;
}

/** Classify one header comma-field by vocabulary membership (R5). */
function classifyField(field: string): FieldClass {
  const low = field.toLowerCase();
  const out: FieldClass = { recognised: false, surfaceBucket: null, techBucket: null, nl: false, en: false };
  for (const m of SURFACE_MATCHERS) {
    if (m.re.test(low)) {
      out.recognised = true;
      if (!out.surfaceBucket) out.surfaceBucket = m.bucket;
      m.langs.forEach((l) => (l === "nl" ? (out.nl = true) : (out.en = true)));
    }
  }
  for (const m of POSITION_MATCHERS) {
    if (m.re.test(low)) {
      out.recognised = true;
      m.langs.forEach((l) => (l === "nl" ? (out.nl = true) : (out.en = true)));
    }
  }
  for (const m of TECHNIQUE_MATCHERS) {
    if (m.re.test(low)) {
      out.recognised = true;
      if (!out.techBucket) out.techBucket = m.bucket;
      m.langs.forEach((l) => (l === "nl" ? (out.nl = true) : (out.en = true)));
    }
  }
  return out;
}

function extractCollectorMarks(text: string): { catalogue: string; number: string }[] {
  const marks: { catalogue: string; number: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(LUGT_RE)) {
    const number = m[1].toUpperCase();
    if (!seen.has(number)) {
      seen.add(number);
      marks.push({ catalogue: "Lugt", number });
    }
  }
  return marks;
}

function extractQuotes(text: string): string[] {
  const out: string[] = [];
  for (const re of QUOTE_RES) {
    for (const m of text.matchAll(re)) {
      const q = m[1].trim();
      if (q) out.push(decodeEntities(q));
    }
  }
  return out;
}

// ─── Core parse ────────────────────────────────────────────────────

/**
 * Parse `artworks.inscription_text` into per-segment structured records.
 * Accepts the raw `|`-joined blob or a pre-split segment array (e.g. the
 * `inscriptions` field already split by get_artwork_details).
 */
export function parseInscriptions(input: string | string[] | null | undefined): ParsedInscription[] {
  if (!input) return [];
  const segments = Array.isArray(input)
    ? input
    : input.split("|");
  const out: ParsedInscription[] = [];
  let seq = 0;
  for (const rawSeg of segments) {
    const raw = rawSeg.trim();
    if (!raw) continue;
    out.push(parseSegment(raw, seq++));
  }
  return out;
}

function parseSegment(raw: string, sequence: number): ParsedInscription {
  const colon = raw.indexOf(":");
  const header = (colon >= 0 ? raw.slice(0, colon) : raw).trim();
  const value = colon >= 0 ? raw.slice(colon + 1).trim() : null;

  // Header = type (field 0) followed by a variable-length, any-order run of
  // placement/technique qualifiers. Some segments are type-less (the header
  // starts directly with a qualifier, e.g. `verso, handgeschreven: …`), so the
  // type slot is claimed only when field[0] is a known type OR is not itself a
  // recognised qualifier (an unrecognised type token, kept for the diagnostic).
  const fields = header.split(",").map((f) => f.trim()).filter(Boolean);

  let typeRaw: string | null = null;
  let typeEntry: SurfaceEntry | undefined;
  let qualifierFields: string[];
  if (fields.length === 0) {
    qualifierFields = [];
  } else {
    const first = fields[0];
    const firstType = TYPE_FORWARD.get(first.toLowerCase());
    if (firstType) {
      typeRaw = first;
      typeEntry = firstType;
      qualifierFields = fields.slice(1);
    } else if (classifyField(first).recognised) {
      // Type-less segment — field[0] is a placement/technique qualifier.
      qualifierFields = fields;
    } else {
      typeRaw = first; // unrecognised type token (surfaces in the residue report)
      qualifierFields = fields.slice(1);
    }
  }
  const normalizedType = typeEntry?.bucket ?? null;

  const placementParts: string[] = [];
  const techniqueParts: string[] = [];
  const unknownQualifiers: string[] = [];
  let normalizedPlacement: string | null = null;
  let normalizedTechnique: string | null = null;
  const qualifierLangs = new Set<Lang>();

  for (const field of qualifierFields) {
    const c = classifyField(field);
    if (c.surfaceBucket && !normalizedPlacement) normalizedPlacement = c.surfaceBucket;
    if (c.techBucket && !normalizedTechnique) normalizedTechnique = c.techBucket;
    if (c.nl) qualifierLangs.add("nl");
    if (c.en) qualifierLangs.add("en");
    if (!c.recognised) {
      unknownQualifiers.push(field);
    } else if (c.techBucket && !c.surfaceBucket) {
      techniqueParts.push(field);
    } else if (c.techBucket) {
      placementParts.push(field);
      techniqueParts.push(field);
    } else {
      placementParts.push(field);
    }
  }

  const valueText = value ? decodeEntities(value) : null;
  const collectorMarks = value ? extractCollectorMarks(value) : [];
  const transcribedText = value ? extractQuotes(value) : [];

  const isCollectorMark =
    collectorMarks.length > 0 || normalizedType === "collector's mark";
  const isPlaceholder =
    transcribedText.length === 0 &&
    collectorMarks.length === 0 &&
    (!value || value.length === 0) &&
    normalizedType != null;

  // Language (R3): the detailed Dutch cataloguing form carries Dutch qualifiers,
  // so their presence ⇒ nl; an English-only qualifier run ⇒ en. With no
  // qualifiers, infer from the type token; a bilingual-only token ⇒ unknown.
  let language: "nl" | "en" | "unknown";
  if (qualifierLangs.has("nl")) {
    language = "nl";
  } else if (qualifierLangs.has("en")) {
    language = "en";
  } else if (typeEntry && typeEntry.langs.size === 1) {
    language = typeEntry.langs.has("nl") ? "nl" : "en";
  } else {
    language = "unknown";
  }

  return {
    sequence,
    raw,
    language,
    type: typeRaw,
    normalizedType,
    placement: placementParts.length ? placementParts.join(", ") : null,
    normalizedPlacement,
    technique: techniqueParts.length ? techniqueParts.join(", ") : null,
    normalizedTechnique,
    value: valueText,
    transcribedText,
    collectorMarks,
    unknownQualifiers,
    isCollectorMark,
    isPlaceholder,
  };
}

// ─── Per-artwork summary ───────────────────────────────────────────

export function summarizeInscriptions(parsed: ParsedInscription[]): InscriptionSummary {
  const collectorMarks = new Set<string>();
  const types = new Set<string>();
  const placements = new Set<string>();
  const techniques = new Set<string>();
  let hasTranscribedText = false;

  for (const p of parsed) {
    if (p.transcribedText.length) hasTranscribedText = true;
    for (const m of p.collectorMarks) collectorMarks.add(`${m.catalogue} ${m.number}`);
    if (p.normalizedType) types.add(p.normalizedType);
    if (p.normalizedPlacement) placements.add(p.normalizedPlacement);
    if (p.normalizedTechnique) techniques.add(p.normalizedTechnique);
  }

  return {
    hasTranscribedText,
    hasCollectorMarkOnly: !hasTranscribedText && collectorMarks.size > 0,
    collectorMarks: [...collectorMarks],
    types: [...types],
    placements: [...placements],
    techniques: [...techniques],
  };
}

// ─── Per-segment facet matching (search_inscriptions, R5) ──────────

/** Per-segment facet predicate inputs for `inscriptionMatchesFacets`. */
export interface InscriptionFacets {
  types: string[];
  placements: string[];
  techniques: string[];
  collectorMark?: string;
  transcribedText?: string;
}

/**
 * Confirm a comma-joined-raw facet (placement/technique): match the normalised
 * bucket OR any raw catalogued token. So an unmapped value or a Dutch surface form
 * (e.g. "achterzijde"→verso, "gestempeld"→stamped) still confirms against the
 * literal FTS narrow instead of being dropped. The raw field is a comma-joined
 * token string ("verso, linksonder"), so it is split and compared token-by-token.
 */
function matchesBucketOrRawTokens(wanted: string[], normalized: string | null, raw: string | null): boolean {
  const w = wanted.map((x) => x.toLowerCase());
  if (normalized != null && w.includes(normalized.toLowerCase())) return true;
  const rawTokens = raw ? raw.toLowerCase().split(/,\s*/) : [];
  return rawTokens.some((t) => w.includes(t));
}

/**
 * Does this segment satisfy every provided per-segment inscription facet?
 * Each facet must hold for THIS segment, so "handwritten signature on the recto"
 * requires one segment that is signature AND recto AND handwritten, not three
 * separate segments that each satisfy one facet.
 */
export function inscriptionMatchesFacets(seg: ParsedInscription, f: InscriptionFacets): boolean {
  if (f.types.length) {
    // Match the normalised bucket OR the raw catalogued type token, so values
    // outside the documented bucket set (an unmapped type, or a Dutch surface form
    // like "signatuur") still confirm against the literal FTS narrow rather than
    // being silently dropped — honouring the "unknown values fall through" contract.
    const wanted = f.types.map((t) => t.toLowerCase());
    const matched =
      (seg.normalizedType != null && wanted.includes(seg.normalizedType.toLowerCase())) ||
      (seg.type != null && wanted.includes(seg.type.toLowerCase()));
    if (!matched) return false;
  }
  if (f.placements.length && !matchesBucketOrRawTokens(f.placements, seg.normalizedPlacement, seg.placement)) return false;
  if (f.techniques.length && !matchesBucketOrRawTokens(f.techniques, seg.normalizedTechnique, seg.technique)) return false;
  if (f.collectorMark) {
    const num = f.collectorMark.match(/(\d+[a-z]?)/i)?.[1]?.toUpperCase();
    const q = f.collectorMark.toLowerCase();
    const ok = seg.collectorMarks.some((m) =>
      (num != null && m.number === num) || `${m.catalogue} ${m.number}`.toLowerCase().includes(q));
    if (!ok) return false;
  }
  if (f.transcribedText) {
    const q = f.transcribedText.toLowerCase();
    if (!seg.transcribedText.some((t) => t.toLowerCase().includes(q))) return false;
  }
  return true;
}

// ─── Result-layer dedup (R6/R6a) ───────────────────────────────────

function normValue(s: string): string {
  return decodeEntities(s).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Collapse the NL/EN gloss pair of a single mark while preserving distinct
 * physical marks that happen to share the same text (R6a). Identity = normalised
 * transcribed value (or type + collector number for value-less marks). Placement
 * and technique are merge payload, gathered into `occurrences[]` — derived only
 * from placement-bearing variants so the null-bearing gloss never double-counts.
 */
export function groupInscriptionMatches(parsed: ParsedInscription[]): InscriptionMatch[] {
  const groups = new Map<string, ParsedInscription[]>();
  for (const p of parsed) {
    let key: string;
    if (p.transcribedText.length) {
      key = `val:${normValue(p.transcribedText.join(" "))}`;
    } else if (p.collectorMarks.length) {
      const m = p.collectorMarks[0];
      key = `mark:${m.catalogue}:${m.number}`;
    } else if (p.normalizedType) {
      key = `type:${p.normalizedType}`;
    } else {
      key = `raw:${p.raw.toLowerCase()}`;
    }
    const arr = groups.get(key);
    if (arr) arr.push(p);
    else groups.set(key, [p]);
  }

  const out: InscriptionMatch[] = [];
  for (const members of groups.values()) {
    const withType = members.find((m) => m.normalizedType) ?? members[0];
    const valueMember = members.find((m) => m.transcribedText.length);
    const markMember = members.find((m) => m.collectorMarks.length);

    // Occurrences from qualified (placement/technique-bearing) variants only.
    const qualified = members.filter((m) => m.normalizedPlacement || m.normalizedTechnique);
    const occSeen = new Set<string>();
    const occurrences: InscriptionMatch["occurrences"] = [];
    for (const m of qualified) {
      const k = `${m.normalizedPlacement}|${m.normalizedTechnique}`;
      if (occSeen.has(k)) continue;
      occSeen.add(k);
      occurrences.push({
        placement: m.normalizedPlacement,
        technique: m.normalizedTechnique,
        language: m.language,
      });
    }
    // No qualified variant (value-only / EN-only) ⇒ a single null-placement occurrence.
    if (occurrences.length === 0) {
      occurrences.push({ placement: null, technique: null, language: members[0].language });
    }

    out.push({
      normalizedType: withType.normalizedType,
      value: valueMember ? valueMember.transcribedText.join(" ") : null,
      ...(markMember && { collectorMark: markMember.collectorMarks[0] }),
      occurrences,
      raw: members.map((m) => m.raw),
    });
  }
  return out;
}

// ─── Embedding source cleanup (R4 — #383 Proposal 2) ──

/**
 * Build a cleaned inscription string for embedding generation: drop collector-mark
 * and placeholder boilerplate, keep transcribed text and described non-mark
 * inscriptions. Single source of truth for the strip, with two consumers (R5):
 * the offline pre-pass `scripts/build-inscription-embed-text.mjs` (which materializes
 * the cleaned text the Modal generator embeds), and VocabularyDb.reconstructSourceText()
 * (which mirrors that format for the post-KNN grounding text shown in semantic_search).
 * Both must apply this so the displayed source text reconstructs the embedded format.
 */
export function formatInscriptionsForEmbedding(
  input: string | string[] | null | undefined,
): string {
  const parsed = parseInscriptions(input);
  const kept: string[] = [];
  for (const p of parsed) {
    if (p.isPlaceholder) continue;
    if (p.isCollectorMark && p.transcribedText.length === 0) continue;
    if (p.transcribedText.length) {
      kept.push(...p.transcribedText);
    } else if (p.value) {
      kept.push(p.value);
    }
  }
  // De-dup exact repeats — each mark is recorded twice (NL form + EN gloss) with
  // identical quoted text, so without this every signature embeds twice (R4).
  const seen = new Set<string>();
  return kept.filter((s) => (seen.has(s) ? false : (seen.add(s), true))).join(" ");
}
