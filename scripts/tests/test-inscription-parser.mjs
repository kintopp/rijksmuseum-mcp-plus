/**
 * Unit tests for the inscription parser (src/inscriptions.ts → issue #383).
 *
 * Run:  node scripts/tests/test-inscription-parser.mjs
 * Requires: npm run build (imports from dist/)
 *
 * Fixtures cover the cases enumerated in the issue's design discussion: Lugt
 * marks, the `datum | date` placeholder, 'RPK', multi-mark records, signature/
 * date combinations, no-colon segments, NL-only/EN-only segments, HTML entities,
 * illegible [...], multiple quoted strings, R5 multi-qualifier placement, and the
 * R6/R6a gloss-dedup edge cases (EN-first, value-separated, distinct physical
 * marks sharing text).
 */

import {
  parseInscriptions,
  summarizeInscriptions,
  groupInscriptionMatches,
  formatInscriptionsForEmbedding,
  INSCRIPTION_TYPE_TOKENS,
  INSCRIPTION_TECHNIQUE_TOKENS,
  INSCRIPTION_PLACEMENT_TOKENS,
  INSCRIPTION_TYPES,
} from "../../dist/inscriptions.js";

// ── Test helpers ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function assertEq(actual, expected, msg) {
  const ok = actual === expected;
  assert(ok, ok ? msg : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertDeepEq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, ok ? msg : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(name) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(60)}`);
}

// ── 1. The dominant collector-mark pair ──────────────────────────

section("Collector's mark (Lugt) — the NL/EN pair");
{
  const p = parseInscriptions(
    "verzamelaarsmerk, verso, gestempeld: Lugt 2228 | collector's mark: Lugt 2228",
  );
  assertEq(p.length, 2, "two segments parsed");

  const nl = p[0];
  assertEq(nl.normalizedType, "collector's mark", "NL type → collector's mark");
  assertEq(nl.normalizedPlacement, "verso", "NL placement → verso");
  assertEq(nl.normalizedTechnique, "stamped", "NL technique → stamped");
  assertEq(nl.language, "nl", "NL segment language=nl (Dutch qualifiers)");
  assertEq(nl.isCollectorMark, true, "NL isCollectorMark=true");
  assertEq(nl.isPlaceholder, false, "NL not a placeholder");
  assertDeepEq(nl.collectorMarks, [{ catalogue: "Lugt", number: "2228" }], "NL Lugt 2228 extracted");
  assertDeepEq(nl.transcribedText, [], "collector mark carries no transcribed text");

  const en = p[1];
  assertEq(en.normalizedType, "collector's mark", "EN gloss type → collector's mark");
  assertEq(en.normalizedPlacement, null, "EN gloss has no placement");
  assertEq(en.language, "en", "EN gloss language=en (English type, no qualifiers)");

  const sum = summarizeInscriptions(p);
  assertEq(sum.hasTranscribedText, false, "summary: no transcribed text");
  assertEq(sum.hasCollectorMarkOnly, true, "summary: collector-mark only");
  assertDeepEq(sum.collectorMarks, ["Lugt 2228"], "summary: Lugt 2228");
}

section("Lugt 240 with corner qualifier (R5 compound placement)");
{
  const p = parseInscriptions(
    "verzamelaarsmerk, verso linksonder, gestempeld: Lugt 240 | collector's mark: Lugt 240",
  );
  const nl = p[0];
  assertEq(nl.normalizedPlacement, "verso", "surface bucket from compound field → verso");
  assert(nl.placement.includes("linksonder"), "raw placement preserves 'linksonder' (lossless)");
  assertEq(nl.normalizedTechnique, "stamped", "technique → stamped");
  assertDeepEq(nl.unknownQualifiers, [], "no residue for recognised compound field");
}

// ── 2. Placeholder rows (type label, no value) ───────────────────

section("Placeholder: `datum | date`");
{
  const p = parseInscriptions("datum | date");
  assertEq(p.length, 2, "two placeholder segments");
  assertEq(p[0].normalizedType, "date", "datum → date");
  assertEq(p[0].language, "nl", "datum language=nl");
  assertEq(p[0].isPlaceholder, true, "datum is a placeholder");
  assertEq(p[0].value, null, "placeholder has no value");
  assertEq(p[1].normalizedType, "date", "date → date");
  assertEq(p[1].language, "en", "date language=en");
  assertEq(p[1].isPlaceholder, true, "date is a placeholder");
  assertEq(formatInscriptionsForEmbedding("datum | date"), "", "placeholders dropped from embedding source");
}

// ── 3. 'RPK' text stamp ──────────────────────────────────────────

section("'RPK' institutional text stamp");
{
  const p = parseInscriptions("stempel, verso: ‘RPK’");
  assertEq(p[0].normalizedType, "stamp", "stempel → stamp");
  assertDeepEq(p[0].transcribedText, ["RPK"], "‘RPK’ transcribed");
  assertEq(p[0].isPlaceholder, false, "RPK stamp not a placeholder");
}

// ── 4. Signature and date ────────────────────────────────────────

section("Signature and date with transcribed value");
{
  const p = parseInscriptions(
    "signatuur en datum, verso, handgeschreven: ‘G Lamberts .1816.’ | signature and date: ‘G Lamberts .1816.’",
  );
  assertEq(p[0].normalizedType, "signature and date", "signatuur en datum → signature and date");
  assertEq(p[0].normalizedTechnique, "handwritten", "handgeschreven → handwritten");
  assertDeepEq(p[0].transcribedText, ["G Lamberts .1816."], "transcribed signature text");
  assertEq(p[1].language, "en", "EN gloss language=en");

  const sum = summarizeInscriptions(p);
  assertEq(sum.hasTranscribedText, true, "summary: has transcribed text");
  assertEq(sum.hasCollectorMarkOnly, false, "summary: not collector-mark only");
}

// ── 5. No-colon segment & English-only / Dutch-only ──────────────

section("No-colon and single-language segments");
{
  const noColon = parseInscriptions("opschrift");
  assertEq(noColon[0].normalizedType, "inscription", "bare 'opschrift' → inscription type");
  assertEq(noColon[0].value, null, "no colon ⇒ null value");
  assertEq(noColon[0].isPlaceholder, true, "bare type token is a placeholder");

  const enOnly = parseInscriptions("inscription: ‘Amsterdam’");
  assertEq(enOnly[0].language, "en", "'inscription' type ⇒ en");
  assertEq(enOnly[0].normalizedType, "inscription", "inscription → inscription");

  // 'monogram' is identical in NL/EN with no qualifiers ⇒ unknown language.
  const ambiguous = parseInscriptions("monogram: ‘RR’");
  assertEq(ambiguous[0].language, "unknown", "ambiguous bilingual token ⇒ unknown");
  assertEq(ambiguous[0].normalizedType, "monogram", "monogram → monogram");
}

// ── 6. HTML entities & illegible markers ─────────────────────────

section("HTML entities and illegible passages");
{
  const ent = parseInscriptions("opschrift, recto: ‘a &lt;b&gt; c’");
  assertDeepEq(ent[0].transcribedText, ["a <b> c"], "HTML entities decoded in transcribed text");

  const ill = parseInscriptions("opschrift, verso, potlood: ‘[...]’");
  assertEq(ill[0].normalizedTechnique, "pencil", "potlood → pencil");
  assertDeepEq(ill[0].transcribedText, ["[...]"], "illegible marker preserved as transcribed");
}

// ── 7. Multiple quoted strings in one segment ────────────────────

section("Multiple quoted strings in one segment");
{
  const p = parseInscriptions("opschrift, verso, handgeschreven: ‘first line’ ‘second line’");
  assertDeepEq(p[0].transcribedText, ["first line", "second line"], "both quoted strings extracted");
}

// ── 7a. Apostrophes inside curly-quoted text are preserved (not delimiters) ──

section("Apostrophes inside curly quotes preserved");
{
  // Regression: the curly class must close only on ’, never on a straight ', or a
  // transcription with an internal apostrophe truncates at the apostrophe.
  const okayama = parseInscriptions("inscription: ‘pies d'Okayama’");
  assertDeepEq(okayama[0].transcribedText, ["pies d'Okayama"], "apostrophe inside ‘…’ kept (d'Okayama)");

  const leading = parseInscriptions("opschrift, onderzijde: ‘'S Gravenhage’");
  assertDeepEq(leading[0].transcribedText, ["'S Gravenhage"], "leading straight quote inside ‘…’ kept");

  const possessive = parseInscriptions("inscription: ‘glazen prisma's Nieuwe Schouwburg’");
  assertDeepEq(possessive[0].transcribedText, ["glazen prisma's Nieuwe Schouwburg"], "possessive apostrophe inside ‘…’ kept");
}

// ── 8. R5 — variable-length, any-order qualifier run + residue ───

section("R5 — multi-qualifier header classified by membership");
{
  const p = parseInscriptions("annotatie, achterzijde, bovenregel, links, wit krijt: ‘nota’");
  assertEq(p[0].normalizedType, "annotation", "annotatie → annotation");
  assertEq(p[0].normalizedPlacement, "verso", "achterzijde → verso (surface)");
  assert(p[0].placement.includes("bovenregel"), "bovenregel kept as raw placement");
  assert(p[0].placement.includes("links"), "links kept as raw placement");
  assertEq(p[0].normalizedTechnique, "chalk", "'wit krijt' → chalk (krijt within field)");
  assertDeepEq(p[0].unknownQualifiers, [], "all qualifiers recognised, no residue");

  const residue = parseInscriptions("opschrift, banderole, verso: ‘x’");
  assertDeepEq(residue[0].unknownQualifiers, ["banderole"], "unrecognised 'banderole' → residue bucket");
  assertEq(residue[0].normalizedPlacement, "verso", "verso still recognised alongside residue");
}

// ── 8b. Type-less segments (header starts with a qualifier) ──────

section("Type-less segment — header starts with placement (R5 correctness)");
{
  const p = parseInscriptions("verso, handgeschreven: ‘nota bene’");
  assertEq(p[0].type, null, "no type token claimed");
  assertEq(p[0].normalizedType, null, "normalizedType null for type-less segment");
  assertEq(p[0].normalizedPlacement, "verso", "placement still recognised from field[0]");
  assertEq(p[0].normalizedTechnique, "handwritten", "technique recognised");
  assertEq(p[0].language, "nl", "Dutch qualifiers ⇒ nl");
  assertDeepEq(p[0].unknownQualifiers, [], "no residue — field[0] was a qualifier, not residue type");
}

section("Expanded vocabulary buckets (R7 tuning)");
{
  assertEq(parseInscriptions("meesterteken, voorzijde: ‘x’")[0].normalizedType, "maker's mark", "meesterteken → maker's mark");
  assertEq(parseInscriptions("seal: ‘x’")[0].normalizedType, "seal", "seal → seal");
  assertEq(parseInscriptions("omschrift, voorzijde: ‘WATERLOO’")[0].normalizedType, "circumscription", "omschrift → circumscription");
  assertEq(parseInscriptions("merkteken, voorzijde, afgeslagen: ‘x’")[0].normalizedTechnique, "struck", "afgeslagen → struck");
  assertEq(parseInscriptions("opschrift, gepreegd: ‘x’")[0].normalizedTechnique, "embossed", "gepreegd → embossed");
  // English-side placement (R5): the EN gloss occasionally carries a direction.
  const en = parseInscriptions("inscription, bottom left: ‘x’")[0];
  assertEq(en.language, "en", "English placement ⇒ en");
  assert(en.placement.includes("bottom left"), "English position kept as raw placement");
}

// ── 9. R6/R6a — gloss dedup at the result layer ──────────────────

section("R6/R6a — value-grouped gloss dedup, EN-first, separated");
{
  // EN gloss first, NL detail later, separated by other segments (real record).
  const record =
    "name: ‘dirk/ 2de graaf’ | naam, verso, handgeschreven: ‘dirk/ 2de graaf’ | " +
    "collector's mark: Lugt 2228 | verzamelaarsmerk, verso, gestempeld: Lugt 2228 | " +
    "number: ‘903’ | nummer, verso midden boven, handgeschreven: ‘903’";
  const matches = groupInscriptionMatches(parseInscriptions(record));

  // Three logical marks: the name, the Lugt stamp, the number — gloss pairs merged.
  assertEq(matches.length, 3, "6 segments collapse to 3 logical marks");

  const name = matches.find((m) => m.value === "dirk/ 2de graaf");
  assert(!!name, "name mark present");
  assertEq(name.occurrences.length, 1, "name has one occurrence (qualified NL variant only)");
  assertDeepEq(
    name.occurrences[0],
    { placement: "verso", technique: "handwritten", language: "nl" },
    "name occurrence carries placement/technique from the NL variant, no null-gloss phantom",
  );

  const mark = matches.find((m) => m.collectorMark);
  assertEq(mark.collectorMark.number, "2228", "collector mark grouped on Lugt number");
  assertEq(mark.occurrences.length, 1, "Lugt mark: one occurrence (NL stamped variant)");
  assertEq(mark.occurrences[0].technique, "stamped", "Lugt occurrence technique=stamped");
}

section("R6a — distinct physical marks sharing text stay distinct");
{
  // Same transcribed value, two different surfaces ⇒ ONE logical entry, TWO occurrences.
  const record =
    "opschrift, recto, gedrukt: ‘WATERLOO’ | opschrift, verso, gestempeld: ‘WATERLOO’";
  const matches = groupInscriptionMatches(parseInscriptions(record));
  assertEq(matches.length, 1, "same text ⇒ one logical match");
  assertEq(matches[0].occurrences.length, 2, "two distinct physical occurrences preserved");
  const surfaces = matches[0].occurrences.map((o) => o.placement).sort();
  assertDeepEq(surfaces, ["recto", "verso"], "occurrences span recto and verso");
}

// ── 10. Inverse maps / public contract ───────────────────────────

section("Inverse maps and closed bucket vocabulary (R2)");
{
  assertDeepEq(
    INSCRIPTION_TYPE_TOKENS.get("collector's mark"),
    ["verzamelaarsmerk", "collector's mark"],
    "type inverse map expands to {nl, en} surface tokens",
  );
  assertDeepEq(
    INSCRIPTION_TECHNIQUE_TOKENS.get("stamped"),
    ["gestempeld", "stamped"],
    "technique inverse map expands stamped",
  );
  assertDeepEq(
    INSCRIPTION_PLACEMENT_TOKENS.get("verso"),
    ["verso", "achterzijde", "keerzijde", "reverse"],
    "placement inverse map expands verso surfaces (incl. numismatic 'reverse')",
  );
  assert(INSCRIPTION_TYPES.includes("collector's mark"), "INSCRIPTION_TYPES exports the closed contract");
}

// ── 11. formatInscriptionsForEmbedding (R4) ──────────────────────

section("Embedding source cleanup keeps text, drops boilerplate");
{
  const cleaned = formatInscriptionsForEmbedding(
    "verzamelaarsmerk, verso, gestempeld: Lugt 2228 | collector's mark: Lugt 2228 | " +
    "signatuur, recto, handgeschreven: ‘Rembrandt f’ | datum | date",
  );
  assert(cleaned.includes("Rembrandt f"), "transcribed signature retained");
  assert(!cleaned.includes("Lugt"), "Lugt boilerplate stripped");
  assert(!/\bdate\b/i.test(cleaned), "placeholder dropped");
}

// ── 12. Empty / null robustness ──────────────────────────────────

section("Robustness");
{
  assertDeepEq(parseInscriptions(null), [], "null ⇒ []");
  assertDeepEq(parseInscriptions(""), [], "empty string ⇒ []");
  assertDeepEq(parseInscriptions("   |  | "), [], "whitespace-only segments dropped");
  // Array input (pre-split inscriptions field from get_artwork_details).
  const fromArray = parseInscriptions(["collector's mark: Lugt 5", "datum"]);
  assertEq(fromArray.length, 2, "array input parsed per-element");
  assertEq(fromArray[0].collectorMarks[0].number, "5", "array element parsed");
}

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
