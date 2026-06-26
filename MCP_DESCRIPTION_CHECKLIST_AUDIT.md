# MCP Description Audit — `rijksmuseum-mcp+`

Evaluation of the server `instructions` block and all 19 tool descriptions against
`mcp-description-checklist.md` (Anthropic / OpenAI FC / OpenAI Apps SDK / MCP spec 2025-11-25 / arXiv research).

- **Scope audited:** `src/index.ts` (server `instructions`), `src/registration/tools/*.ts` (19 tools), `src/registration/helpers.ts` (annotations, response shaping).
- **Date:** 2026-06-26 · code `c99ceb9` (main) · 16 model-facing tools + 3 app-only hidden tools.
- **Verdict legend:** ✅ Conforms · 🟡 Partial / debatable · ❌ Gap.

## Executive summary

The descriptions are, overall, **well above typical MCP-server quality** and conform to the
large majority of the checklist. The team has clearly internalised the two hardest items in the
guidance — *one job per tool with explicit "when NOT to use" routing*, and *the
discovery-vs-invocation length tension* — and encoded them as house rules. The weak spots are
process-level (no labelled precision/recall eval set) and a few narrow annotation/accuracy
edge cases, not authoring quality.

| § | Checklist area | Verdict |
|---|----------------|---------|
| 1 | Tool-set scope | ✅ |
| 2 | Naming | ✅ (one deferred eval) |
| 3 | Tool description prose | ✅ exemplary |
| 4 | Parameters & input schema | ✅ (one structural limit) |
| 5 | Outputs & returned context | ✅ |
| 6 | Annotations & impact hints | 🟡 two edge cases |
| 7 | Token efficiency | ✅ |
| 8 | Errors | ✅ |
| 9 | Server-level metadata | 🟡 missing icon/websiteUrl |
| 10 | Validate-then-iterate | 🟡 no labelled eval set |

---

## § 1 — Scope the tool set ✅

- **A few thoughtful tools, not a wrapper-per-endpoint.** 16 model-facing tools across clearly
  separated jobs (search, semantic, similar, details, stats, provenance, bibliography,
  conservation, inscriptions, persons, sets, recent-changes, viewer family). No 1:1 mapping to
  REST endpoints — most read the local vocab/embeddings DBs.
- **One job per tool.** Each tool is a single read action. The descriptions reinforce the
  boundaries with explicit negative routing in nearly every tool (e.g. `search_artwork`: *"Not
  for free-text concept queries — use semantic_search… Not for artwork-to-artwork similarity —
  use find_similar"*).
- **Consolidation of chained calls.** `get_conservation_history` and `get_artwork_bibliography`
  bundle what would otherwise be multi-lookup workflows; `collection_stats` explicitly replaces
  "looping search_artwork calls" (server instructions say so).
- **Initially-available set < 20.** 16 visible tools — under OpenAI's soft ceiling. The 3
  app-only helpers (`remount_viewer`, `poll_viewer_commands`, and the hidden side of the viewer
  protocol) are correctly hidden via `_meta.ui.visibility: ["app"]`, so they don't count against
  the model's selection budget.
- 🟡 **No labelled prompt set (direct / indirect / negative).** The checklist asks you to
  *assemble* this before writing. The repo has conformance + smoke tests (`test:mcp`,
  `test:track2`, `test:viewer-app`) but no documented direct/indirect/negative prompt corpus with
  expected tool selection. See § 10.

## § 2 — Naming ✅

- **Action-oriented, unique, spec-legal.** All names are `snake_case`, verb-led
  (`search_artwork`, `get_artwork_details`, `find_similar`, `browse_set`,
  `find_artworks_citing_publication`), within `[A-Za-z0-9_.-]`, 1–128 chars, unique within the
  server. ✅ spec name constraints.
- **Principle of least surprise.** Names are intuitive; `inspect_artwork_image` vs
  `get_artwork_image` is a genuinely subtle distinction, but it's disambiguated heavily in both
  descriptions and the server instructions ("base64 bytes for the LLM" vs "interactive viewer for
  the user").
- **Namespacing.** Tools are *not* server-prefixed in their raw names (e.g. `search_artwork`, not
  `rijks_search_artwork`). This is fine: the host applies the namespace at runtime
  (`mcp__…_Rijksmuseum_HTTP__search_artwork`), and within-server uniqueness holds. The
  related-tool families share natural prefixes (`search_*`, `get_artwork_*`).
- 🟡 **Prefix- vs suffix-namespacing not eval-tested.** The checklist explicitly says this has
  measurable, model-dependent effects and should be picked by your own evals. No such eval exists
  here — but the impact is low given host-side prefixing.

## § 3 — The tool description (prose) ✅ — strongest area

This is where the server most clearly exceeds the baseline. Checking each sub-item:

- **"Brief it like a new hire" / make implicit context explicit.** ✅ Heavy. Examples: the
  bilingual-vocab fallback (*"try the Dutch term… 'fotograaf' instead of 'photographer'"*); the
  `technique: 'painting'` trap in `semantic_search` (*"Do NOT use technique: 'painting' — it
  matches painted decoration on any object type"*); `search_persons`' multi-creator-leakage
  caveat.
- **State purpose + what output represents.** ✅ Every description opens with purpose; many name
  the output shape (`search_artwork`: *"Returns artwork summaries with titles, creators, and
  dates; every response includes totalResults (exact match count…)"*).
- **When-to-use AND when-NOT-to-use.** ✅ Near-universal. The "Not for X — use Y" pattern appears
  in `search_artwork`, `semantic_search`, `find_similar`, `get_artwork_details`,
  `collection_stats`, `search_provenance`, `get_conservation_history`,
  `get_artwork_bibliography`, `list_curated_sets`, `browse_set`, the viewer tools. This is the
  single most consistent strength.
- **Guidelines AND limitations (the component research finds most often missing).** ✅ Explicitly
  present and unusually candid: coverage %s (description corpus "~61% coverage"), candidate-cap
  PARTIAL-result warnings (`search_inscriptions`, `semantic_search`), demographic-enrichment
  undercount warnings (`search_persons`), `unsold`/`batchPrice` distortion flags
  (`search_provenance`), the "absence of key works is not visible in the returned results"
  warning for `semantic_search` paintings.
- **Tight-but-complete + put weight where it belongs.** ✅ This is handled by a deliberate
  two-tier design encoded in `CLAUDE.md`: the **lead sentence is budgeted to ≤118 UTF-8 bytes**
  so it survives the host's tool-list truncation, then the richer behavioural guidance follows.
  This is exactly the reconciliation the checklist describes for the discovery-vs-invocation
  tension (disagreement #2) and the deferred-tools model (§3 last bullet). Spot-check of lead
  sentences (all self-contained, all within budget):
  - `search_artwork`: *"Structured filter search — artworks matching ALL given filters (subject, material, technique, date, place, person)."*
  - `find_similar`: *"Given one artwork's objectNumber, finds others like it across 9 similarity channels plus a pooled consensus."*
  - `semantic_search`: *"Free-text concept search by embedding similarity — for ideas like 'solitude' or 'vanitas' that resist metadata."*
- 🟡 **Examples in descriptions (the checklist's clearest disagreement).** The server *does*
  include worked examples (`collection_stats` has 5 query→param examples — trimmed from 7, see
  Recommendation 4; `inspect_artwork_image` lists region presets). The checklist notes OpenAI
  warns examples *may hurt reasoning models*, while Anthropic de-prioritises them. On inspection
  these aren't decorative few-shot but param-mapping documentation — closer to a usage table — so
  the reasoning-model risk is low. The remaining open question is routing accuracy, which only the
  § 10 eval set can settle.
- 🟡 **Two app-only tools are terse** (`poll_viewer_commands`: *"Internal: poll for pending viewer
  navigation commands"*; `remount_viewer`: 3 sentences). This is **correct**, not a gap —
  hidden/deferred tools are exempt per both the checklist (§3 deferred logic) and the project's
  own rule. Noting it only so it isn't mistaken for under-specification.

## § 4 — Parameters & input schema ✅

- **Unambiguous names + described format.** ✅ Parameters carry format + examples in `.describe()`
  almost everywhere: `objectNumber` (*"e.g. 'SK-C-5'"*), `creationDate` (*"Exact year ('1642') or
  wildcard ('16*')"*), `publication` (*"URI (https://id.rijksmuseum.nl/301…) or the bare id"*),
  `region` (full IIIF grammar + presets).
- **Describe every parameter.** ✅ I found no undocumented parameter on any of the 19 tools. Even
  pagination knobs (`offset`, `resumptionToken`, `maxResults`) carry descriptions and bounds.
- **Enums / structure to make invalid states unrepresentable.** ✅ `dateMatch`
  (`overlaps|within|midpoint`), `quality` (`default|gray`), `rotation` (literal `0|90|180|270`),
  `sortBy`, `layer`, `transferType` (closed enum array), `navigate_viewer.action` enum. Good use
  of the type system rather than free strings.
- **Defaults & optional fields documented.** ✅ Defaults are stated in prose *and* enforced in
  Zod (`maxResults` defaults, `region` default `"full"`, `identifiersOnly` default false,
  `includeStats` default true).
- **Strict schema.** ✅ Every `inputSchema` is `z.object({…}).strict()` →
  `additionalProperties: false`, matching the checklist's strict-mode recommendation. Schemas are
  also validated `$ref`-free by `test-inspect-navigate.mjs` (claude.ai compatibility).
- **No-parameter tools.** N/A — every tool takes ≥1 parameter. (If a no-arg tool is ever added,
  the checklist's `{ "type": "object", "additionalProperties": false }` shape is already the
  `.strict()` default.)
- 🟡 **"At least one filter required" is a runtime check, not schema-expressible.**
  `search_artwork` and `search_provenance` enforce "≥1 filter" in the handler, not in JSON Schema
  (JSON Schema's `anyOf`/`minProperties` can't cleanly express it across many optionals). The
  descriptions state the rule explicitly, and the runtime error is actionable, so this is an
  accepted limitation rather than a miss.

## § 5 — Outputs & returned context ✅

- **High-signal fields over low-level IDs.** ✅ List results lead with `title`, `creator`,
  `date`, `type`, human URLs. `objectNumber` is surfaced because it's the *canonical handle* the
  model legitimately needs for follow-up calls — the description says so each time.
- **Resolve cryptic IDs.** ✅ `search_persons` returns `vocabId` *with* a human label, lifespan,
  gender, and Wikidata Q-id, and the description tells the model exactly how to thread the id into
  `search_artwork({creator})`. Authority IDs in `get_artwork_details` are returned as labelled
  `{ authority, id, uri }` triples, not bare numbers.
- **Verbosity controls.** ✅ Plural and well-placed: `full` (bibliography), `compact`
  (provenance), `identifiersOnly` (recent-changes), `includeStats` (sets), `verboseExtent` /
  `includeExtentText` (details/sets), `maxResults`. Matches the checklist's `concise/detailed`
  recommendation in spirit.
- **Declare outputSchema + structured + mirror as text.** ✅ Every tool wraps an output schema via
  `withOutputSchema(...)`; `structuredResponse()` emits `structuredContent` (gated by
  `STRUCTURED_CONTENT`) *and* a human text summary, with an opt-in serialized-JSON mirror
  (`MCP_TEXT_JSON_COMPAT`) for clients that can't read `structuredContent`. This is precisely the
  spec's "structuredContent AND JSON text for compatibility".
- **Response structure picked empirically.** ✅ The chosen shape — compact human text in the text
  channel, full payload in `structuredContent` — is documented (memory notes / `CLAUDE.md`) as a
  response to claude.ai/Desktop *not* reading `structuredContent`. That's the "test it on your
  host" posture the checklist asks for.

## § 6 — Annotations & impact hints 🟡

- ✅ **Hints are set, not omitted.** Two centralised constants (`helpers.ts:19-20`):
  `ANN_READ_CLOSED = {readOnly:true, destructive:false, idempotent:true, openWorld:false}` for
  the 14 read tools; `ANN_VIEWER = {readOnly:false, destructive:false, idempotent:false,
  openWorld:false}` for the viewer-mutating tools. The accompanying comment documents *why*
  `destructiveHint:false` must be explicit (it defaults `true` in the spec) — good practice.
- ✅ **`readOnlyHint`/`destructiveHint` are accurate** for the read tools, and for the viewer
  tools that mutate the server-side `viewerQueues` (`get_artwork_image`, `navigate_viewer`,
  `remount_viewer`) — `readOnlyHint:false` is defensible since they create/steer viewer session
  state.
- 🟡 **`openWorldHint:false` on the two live-network tools is debatable.** The constant applies
  `openWorldHint:false` *universally*, with the rationale "the entire domain is the bounded ~834K
  corpus." That holds for the local-DB tools, but:
  - `get_recent_changes` hits **live OAI-PMH** (`data.rijksmuseum.nl/oai`).
  - `find_similar`'s Visual channel makes a **best-effort live call to `rijksmuseum.nl`**.

  The spec's own example treats web search (live external) as `openWorldHint:true`. These two
  tools interact with an external system whose responses aren't a fixed local snapshot, so
  `openWorldHint:true` would arguably be more truthful. Low-impact (hints are advisory) but it's a
  genuine accuracy nit worth a deliberate decision rather than inheritance.
- 🟡 **`idempotentHint:true` is slightly off for buffer-draining pagination.** `get_recent_changes`
  / `browse_set` consume a server-side resumption buffer; re-issuing the *same* `resumptionToken`
  isn't strictly idempotent. Minor and arguably out of scope of what the hint is meant to convey.
- ✅ **Trust boundary.** The server doesn't rely on annotations for security; Origin validation
  and strict schemas do the enforcing. Consistent with "treat annotations as untrusted on the
  client side."

## § 7 — Token efficiency ✅

- ✅ **Descriptions are recognised as billed context.** The ≤118-byte lead-sentence rule and the
  hidden-tool visibility flags both exist specifically to control tool-list token cost and
  truncation.
- ✅ **Paginate / filter / truncate with sane defaults.** Universal: per-tool `TOOL_LIMITS` (e.g.
  search 25/50, semantic 15/50, provenance 1/50, stats 50/500), `offset`/`resumptionToken`
  pagination, candidate caps with `candidatesCapped`/`PARTIAL` signalling.
- ✅ **Steer the model on truncation.** Descriptions actively tell the model to narrow rather than
  broaden: `search_inscriptions` (*"add a narrowing term"*), `semantic_search` (*"pair it with a
  narrower filter… for exact ranking"*), the object-number-prefix `warnings` note in
  `search_artwork`.
- 🟡 **Two descriptions are heavy.** `collection_stats` and `search_provenance` are the longest
  prose blocks on the server (dimension catalogues + 5 examples; provenance-of-provenance method
  taxonomy). They're information-dense and arguably justified for power tools, but they're the
  obvious first candidates if the tool-list ever bumps a token ceiling. (`collection_stats` was
  trimmed 7 → 5 examples on 2026-06-26 — see Recommendation 4.)

## § 8 — Errors ✅

- ✅ **Two channels used correctly.** Malformed/unknown-tool and schema-violation requests are
  rejected by the SDK + Zod `.strict()` (protocol/JSON-RPC errors). Business/validation failures
  return `isError: true` with text via `errorResponse()` (`helpers.ts:139`). The repo even
  documents *why* `errorResponse` must not emit `structuredContent` (it wouldn't conform to the
  tool's required output fields → `-32602`).
- ✅ **Actionable error text.** Examples: *"Either from or resumptionToken is required."*;
  *"Invalid resumptionToken. Tokens are not portable across server restarts or upgrades. Re-issue
  the original setSpec call to get a fresh token."*; *"Provide exactly one of objectNumber or
  uri."* These tell the model how to self-correct, not just that it failed.
- ✅ **`error` vs `warnings` discipline.** The codebase draws a hard line (documented in
  `CLAUDE.md`): `error`+`isError` = request couldn't produce a usable result; `warnings` =
  succeeded but adjusted/empty with a recovery hint, rendered to text by a single owner
  (`mirrorWarningsToText`). This is more rigorous than the checklist requires.

## § 9 — Server-level metadata 🟡

- ✅ **Name + title.** `name: "rijksmuseum-mcp+"`, `title: "Rijksmuseum MCP+"`, `version` from
  `package.json`.
- ✅ **Server instructions for cross-tool context.** The `instructions` block (`index.ts:204-246`)
  is excellent and does exactly what the checklist asks: corpus scope, the bilingual-vocab rule,
  the three search-mode router (`search_artwork` / `semantic_search` / `find_similar`), the
  viewer-family disambiguation, the `search_persons → search_artwork` two-step, place/proximity
  coordinate caveats, and the Iconclass cross-server workflow. This is genuinely cross-tool
  guidance that doesn't belong in any single description.
- ❌ **No icon and no `websiteUrl`.** The checklist (§9, OpenAI Apps SDK) asks for an
  app/server-level **icon** for directory/launcher discovery; none is set on the
  `Implementation` object. `websiteUrl` is also absent. These are the only outright *missing*
  metadata items in the audit. Low effort to add; improves launcher/registry presentation.

## § 10 — Validate, then iterate 🟡 — main process gap

- ✅ **Operational metrics exist.** `UsageStats` records per-tool call timing + success/failure;
  `/debug/slow-queries` exposes per-input timing. That covers the checklist's "track tool-call
  counts, runtime, error rates."
- ✅ **Conformance/smoke tests exist.** `test:mcp` (19-tool SDK smoke), `test:track2`,
  `test:viewer-app` (MCP-Apps metadata conformance), `$ref`-free schema gates.
- 🟡 / ❌ **No labelled precision/recall eval set for tool selection.** The checklist's single most
  emphasised, cross-source point is that description-writing should be an *evaluation-driven,
  iterative* process: a held-out corpus of **direct / indirect / negative** prompts, scored per
  prompt for *which tool ran* and *whether the right one ran*. The repo's tests verify that tools
  *work*, not that the *descriptions route correctly*. A known constraint compounds this
  (memory): `.skill`-packaged trigger optimisation can't measure recall in headless runs because
  the MCP server is absent. So selection accuracy is currently validated qualitatively, not
  measured.
- ✅ **"Let an agent help refactor" / "intern test."** This very audit is that process; the
  descriptions broadly pass the intern test (a competent newcomer could use each tool from the
  description alone — the heavy caveats are what make that true).

---

## Where the checklist's disagreements land for this server

- **Examples in descriptions (#1):** The server includes them (esp. `collection_stats`). Because
  the hosts are reasoning models, this is the one authoring choice worth an explicit A/B test
  rather than assuming the scaffolding helps.
- **Description length (#2):** *Already resolved the way the checklist recommends* — short
  truncation-safe lead, richer body after, hidden tools kept terse. Best-in-class handling.
- **Where "when to use" lives (#3):** The server correctly puts routing *inside the descriptions*
  (it's a published server that can't rely on the host's system prompt) — the checklist's
  prescribed resolution for MCP servers.

## Recommendations (priority order)

1. **(§10, highest leverage)** Build a small labelled prompt set — direct / indirect / negative —
   with expected tool selection, and score precision/recall per release. This is the one place the
   server falls short of the checklist's strongest, most-agreed principle. Start with the
   genuinely confusable pairs: `get_artwork_image` vs `inspect_artwork_image`, `search_artwork`
   vs `semantic_search` vs `find_similar`, `search_persons` vs `search_artwork({creator})`.
2. **(§6)** Decide deliberately on `openWorldHint` for the two live-network tools
   (`get_recent_changes`, `find_similar` Visual channel) rather than inheriting `false`. Either
   flip them to `true` or document the rationale for keeping `false` next to the constant.
3. **(§9)** Add a server **icon** (and optionally `websiteUrl`) to the `Implementation` metadata —
   the only outright-missing items.
4. **(§3/§7) — DONE (conservative trim applied 2026-06-26).** A closer look showed the
   `collection_stats` examples are *load-bearing routing documentation*, not decorative few-shot:
   each non-trivial one maps fuzzy NL jargon ("autograph", "workshop of", "LLM-mediated
   interpretations", "sales by decade") onto a multi-knob param combo that lives nowhere else in
   the schema. So the wholesale cut this report originally implied was the wrong call. Instead a
   minimal **7 → 5 trim** was applied (`stats.ts` + the `docs/` mirror): dropped *"Top 20 depicted
   persons"* (mechanical — `topN` is self-documenting) and *"What types of artworks have
   provenance?"* (its cross-domain lesson is already carried by the kept Rembrandt example, and it
   made `type`-as-dimension appear 3×). Kept the four high-value mappings (`transferType`
   group-by, `provenanceDecade` + filters, `categoryMethod`, autograph/`sameRowMatching`,
   `attributionQualifier`). Saving is ~50 tokens — small, because the real axis here is routing
   accuracy, not token cost. **Open follow-up:** validating that the trim didn't regress routing
   still requires the §10 eval set; until that exists, this stays an evidence-based judgement, not
   a measured result.

## Bottom line

On authoring quality (§§1–8) the server is a model citizen — particularly on one-job scoping,
explicit when-NOT-to-use routing, candid limitations, strict schemas, dual structured+text
output, and actionable errors. The remaining work is almost entirely **process and a few small
metadata/accuracy fixes**: a measured eval loop (§10), two annotation edge cases (§6), and a
missing server icon (§9).
