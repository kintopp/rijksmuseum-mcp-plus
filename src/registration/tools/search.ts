import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VocabularyDb, type PersonSearchParams, type SearchTimings } from "../../api/VocabularyDb.js";
import { UsageStats } from "../../utils/UsageStats.js";
import {
  ANN_READ_CLOSED,
  TOOL_LIMITS,
  MODIFIER_KEYS,
  COMPOUND_PUBLIC_KEYS,
  FACET_DIMENSIONS,
  stripNull,
  stripNullCoerceBool,
  normalizeStringOrArray,
  stringOrArray,
  optStr,
  optMinStr,
  textQuerySchema,
  type InferOutput,
  errorResponse,
  structuredResponse,
  withOutputSchema,
  formatSearchLine,
  detectComponentClustering,
  formatFacets,
  addPercentages,
  parseDimRange,
  parseSortParam,
  createLogger,
} from "../helpers.js";
import {
  SearchResultOutput,
} from "../outputSchemas.js";

export function registerSearchTools(
  server: McpServer,
  vocabDb: VocabularyDb | null,
  withLogging: ReturnType<typeof createLogger>,
  stats?: UsageStats
): void {
  // ── search_artwork ──────────────────────────────────────────────

  // Vocabulary-backed search params (require vocabulary DB)
  const vocabAvailable = vocabDb?.available ?? false;
  // All search parameters that the vocab DB handles.
  // With vocab-DB-only routing (v0.19), every parameter routes through the vocab DB.
  const vocabParamKeys = [
    "subject", "iconclass", "depictedPerson", "depictedPlace", "productionPlace",
    "collectionSet",
    // Tier 2 (vocabulary DB v1.0+)
    "description", "inscription", "curatorialNarrative", "textQuery", "productionRole", "attributionQualifier",
    "heightRange", "widthRange",
    "nearPlace", "nearLat", "nearLon",
    "material", "technique", "type", "creator",
    "creationDate",
    "objectNumber",
    "imageAvailable",
    "hasProvenance",
    "aboutActor",
    // Place hierarchy
    "expandPlaceHierarchy",
    // v0.27 — curatorial theme + source-channel taxonomy
    "theme", "sourceType",
    // #357 — same-row matching modifier for creator + productionRole
    "sameRowMatching",
  ] as const;
  // nearPlaceRadius excluded from routing key check: its Zod default (25) would trigger
  // on every query. Forwarded separately. sort is also forwarded but never counts as a
  // substantive filter for the "at-least-one-filter-required" check.
  const allVocabKeys = [...vocabParamKeys, "nearPlaceRadius", "dateMatch", "sort"] as const;

  server.registerTool(
    "search_artwork",
    {
      title: "Search Artwork",
      annotations: ANN_READ_CLOSED,
      description:
        "Structured filter search — artworks matching ALL given filters (subject, material, technique, date, place, person). " +
        "Returns artwork summaries with titles, creators, and dates; every response includes totalResults (exact match count, not just the returned page). " +
        "Not for free-text concept queries — use semantic_search for those. " +
        "Not for artwork-to-artwork similarity — use find_similar with an objectNumber. " +
        "For demographic person queries (gender, born/died, profession, birth/death place), use search_persons first to get a vocabId, then pass it as creator here. " +
        "For provenance text and ownership history, use search_provenance. " +
        "For aggregate counts and distributions, prefer collection_stats — one call vs compact=true loops.\n\n" +
        "Ranking: relevance (BM25) when text search (description, title, etc.) or geographic proximity is used; otherwise importance (image availability, curatorial attention, metadata richness). " +
        "For concept-ranked results, use semantic_search.\n\n" +
        "At least one filter is required. There is no full-text search across all metadata. " +
        "For concept or thematic searches (e.g. 'winter landscape', 'smell', 'crucifixion'), ALWAYS start with subject — it searches ~832K artworks tagged with structured Iconclass vocabulary and has by far the highest recall for conceptual queries. " +
        "Use description for cataloguer observations (compositional details, specific motifs); use curatorialNarrative for curatorial interpretation and art-historical context. These three corpora can return complementary results. " +
        "For broader concept discovery beyond structured vocabulary, use semantic_search — but combine it with search_artwork(type: 'painting', …) for painting queries since paintings are underrepresented there.\n\n" +
        "Array values are AND-combined (e.g. subject: ['landscape', 'seascape'] finds artworks with both). " +
        "If many results share an object-number prefix (e.g. multiple folios of one sketchbook), a `warnings` note flags it; narrow with type/material filters or treat the shared prefix as the unit. " +
        "Each result carries an objectNumber for follow-up calls to get_artwork_details (full metadata) or get_artwork_image (deep-zoom viewer — only when the user asks to see, show, or view an artwork; do not open the viewer for list/count/summary requests)." +
        (vocabAvailable
          ? " All parameters combine freely. Vocabulary labels are bilingual (English and Dutch); try the Dutch term if English returns no results (e.g. 'fotograaf' instead of 'photographer'). " +
            "For proximity search, use nearPlace with a place name, or nearLat/nearLon for arbitrary locations. " +
            "For acquisition channel / donor analysis (gifts, bequests, fund names like 'Vereniging Rembrandt'), use search_provenance."
          : ""),
      inputSchema: z.object({
        query: optStr()
          .optional()
          .describe(
            "Search by artwork title — matches against all title variants (brief, full, former × EN/NL). " +
            "Note: only ~4% of artworks have an English title (~35K of 833K). " +
            "For non-title text, use the specific field parameters (description, inscription, curatorialNarrative, creator, subject, etc.)."
          ),
        creator: stringOrArray()
          .optional()
          .describe(
            "Search by artist name (e.g. 'Rembrandt van Rijn'), or pass a vocabId from search_persons " +
            "(e.g. '210169673') for an exact match to that one person — preferred over the name when you " +
            "have it, since shared names can match multiple distinct artists."
          ),
        aboutActor: optStr()
          .optional()
          .describe(
            "Search for artworks depicting or about a person (not the creator). E.g. 'Willem van Oranje'. " +
            "Broader recall than depictedPerson — searches both subject and creator vocabulary, tolerant of " +
            "cross-language name forms (e.g. 'Louis XIV' finds 'Lodewijk XIV'). Combinable with all other filters. " +
            "depictedPerson is usually the better first choice (precise, depicted persons only); " +
            "use aboutActor for broader person matching across depicted persons and creators."
          ),
        type: stringOrArray()
          .optional()
          .describe("Filter by object type: 'painting', 'print', 'drawing', etc."),
        material: stringOrArray()
          .optional()
          .describe("Filter by material: 'canvas', 'paper', 'wood', etc."),
        technique: stringOrArray()
          .optional()
          .describe("Filter by technique: 'oil painting', 'etching', etc."),
        creationDate: optStr()
          .optional()
          .describe(
            "Filter by creation date. Exact year ('1642') or wildcard ('16*' for 1600s, '164*' for 1640s)."
          ),
        dateMatch: z.preprocess(stripNull,
          z.enum(["overlaps", "within", "midpoint"]).optional(),
        ).describe(
            "How creationDate matches artwork date ranges. " +
            "\"overlaps\" (default): artwork range overlaps query range — inclusive, but objects with broad ranges appear in multiple bins. " +
            "\"within\": artwork range falls entirely within query range — exclusive bins, but drops broadly-dated objects (~43% of collection spans >1 decade). " +
            "\"midpoint\": assigns each artwork to one bin by midpoint of its date range — every object counted exactly once with no data loss. Best for statistical comparisons and charts."
          ),
        objectNumber: optStr()
          .optional()
          .describe(
            "Filter by object number. Exact match by default (e.g. 'SK-C-5' for The Night Watch). " +
            "Supports wildcards: '*' matches any run of characters, '?' matches a single character — " +
            "e.g. 'SK-C-5*' for the Night Watch group, 'RP-P-1906-*' for a print-acquisition series, 'BK-NM-*'. " +
            "Case-sensitive (object numbers are predominantly uppercase). " +
            "A wildcard pattern needs at least 2 literal characters."
          ),
        description: optStr()
          .optional()
          .describe(
            "Full-text search on artwork descriptions (~510K artworks, 61% coverage). " +
            "Cataloguer observations including compositional details, motifs, physical condition, and attribution remarks. " +
            "Exact word matching, no stemming."
          ),
        imageAvailable: z.preprocess(stripNullCoerceBool, z.boolean().optional())
          .describe(
            "Filter by digitisation: true = only artworks with a digital image, " +
            "false = only artworks lacking one (e.g. un-photographed works on paper). " +
            "Cannot be used alone — combine with at least one other filter."
          ),
        hasProvenance: z.preprocess(stripNullCoerceBool, z.boolean().optional())
          .describe(
            "If true, only return artworks that have parsed provenance records (~48K of 832K). " +
            "Combine with other filters for cross-domain queries (e.g. type='painting' + hasProvenance=true). " +
            "Cannot be used alone — combine with at least one other filter."
          ),
        // Vocabulary-backed params
        ...(vocabAvailable
          ? {
              subject: stringOrArray()
                .optional()
                .describe(
                  "PRIMARY parameter for concept or thematic searches — use this first, before description or curatorialNarrative. " +
                  "Searches ~832K artworks by subject matter (Iconclass themes, depicted scenes). " +
                  "Has basic English morphological expansion (singular/plural, -ing, -ed) as a fallback — " +
                  "'cat' matches 'cats' and 'painting' matches 'paint', but unrelated derivations like " +
                  "'crucifixion' vs 'crucified' are not linked. " +
                  "If a subject query returns 0 results, try different word forms " +
                  "or use the Iconclass server's search tool to find the canonical Iconclass notation code for more reliable matching. " +
                  "Also covers historical events using Dutch labels (e.g. 'Tweede Wereldoorlog', 'Tachtigjarige Oorlog'). " +
                  "Subject matching does not distinguish primary from incidental/decorative subjects — " +
                  "a mortar with an Annunciation relief will match 'Annunciation'. Combine with type (e.g. type: 'painting') to filter."
                ),
              iconclass: stringOrArray()
                .optional()
                .describe(
                  "Exact Iconclass notation code (e.g. '34B11' for dogs, '73D82' for Crucifixion). More precise than subject (exact code vs. label text) — use the Iconclass server's search tool to discover codes by concept."
                ),
              depictedPerson: stringOrArray()
                .optional()
                .describe(
                  "Search for artworks depicting a specific person by name (e.g. 'Willem van Oranje'). " +
                  "Matches against 210K name variants including historical forms. Combinable with all vocabulary filters. " +
                  "Searches depicted persons only; use aboutActor for broader person matching (depicted + creators)."
                ),
              depictedPlace: stringOrArray()
                .optional()
                .describe(
                  "Search for artworks depicting a specific place by name (e.g. 'Amsterdam'). " +
                  "Supports multi-word and ambiguous place names with geo-disambiguation (e.g. 'Oude Kerk Amsterdam')."
                ),
              productionPlace: stringOrArray()
                .optional()
                .describe(
                  "Search for artworks produced in a specific place (e.g. 'Delft'). " +
                  "Spans both the Linked Art production-place field and the OAI-PMH spatial field for maximum recall. " +
                  "Supports multi-word and ambiguous place names with geo-disambiguation (e.g. 'Paleis van Justitie Den Haag')."
                ),
              collectionSet: stringOrArray()
                .optional()
                .describe(
                  "Search for artworks in curated collection sets by name (e.g. 'Rembrandt', 'Japanese'). " +
                  "Use list_curated_sets to discover available sets."
                ),
              theme: stringOrArray()
                .optional()
                .describe(
                  "Curatorial thematic tag (e.g. 'overzeese geschiedenis', 'economische geschiedenis', 'costume'). " +
                  "Distinct from subject (Iconclass) and depicted persons/places — themes group works around " +
                  "collection-level narratives. ~7% of artworks have at least one theme; coverage is skewed " +
                  "to historical-collection works. Most theme labels are Dutch (~17% have curated English labels)."
                ),
              sourceType: stringOrArray()
                .optional()
                .describe(
                  "Source-channel classification: 'designs' (90K), 'drawings' (49K), 'paintings' (46K), " +
                  "'prints (visual works)' (19K), 'sculpture (visual works)' (5K), 'photographs' (3K). " +
                  "Distinct from `type` — sourceType reflects the cataloguing source, while type uses " +
                  "Linked Art object-classification vocabulary."
                ),
              inscription: optMinStr()
                .optional()
                .describe(
                  "Full-text search on inscription texts (~500K artworks — signatures, mottoes, dates on the object surface, not conceptual content). " +
                  "Exact word matching, no stemming. E.g. 'Rembrandt f.' for signed works, Latin phrases."
                ),
              curatorialNarrative: optMinStr()
                .optional()
                .describe(
                  "Full-text search on curatorial narrative (~14K artworks with museum wall text). " +
                  "Best for art-historical interpretation, exhibition context, and scholarly commentary — " +
                  "content written by curators that goes beyond what structured vocabulary captures. " +
                  "Exact word matching, no stemming. For broad concept searches, start with subject instead."
                ),
              textQuery: textQuerySchema()
                .optional()
                .describe(
                  "Advanced structured text search over the four text fields (title, description, inscription, curatorialNarrative). " +
                  "Use ONLY when the flat text filters above cannot express the query — boolean nesting, cross-field either/or, proximity, or prefix. " +
                  "Shape: { must?: Clause[], should?: Clause[], mustNot?: Clause[] }. must=AND, should=OR-group, mustNot=excluded. At least one must/should clause is required (mustNot alone is rejected). " +
                  "Each Clause targets one field (default: all four) and OR-combines its terms: " +
                  "{ field?, phrase?: exact words, any?: [tokens] (OR), prefix?: stem (matches stem*), anyPrefix?: [stems] (OR), near?: { terms: [t1, t2, …], distance } }. " +
                  "In near.terms, a nested array is OR alternatives at that position. Combine with the other filters (type, creator, creationDate, …) freely. " +
                  "Example — a theme phrased differently per field: { should: [{ field: 'description', phrase: 'beeldenstorm' }, { field: 'curatorialNarrative', any: ['iconoclasm','iconoclastic'] }], mustNot: [{ field: 'title', phrase: 'geschiedenis' }] }."
                ),
              productionRole: stringOrArray()
                .optional()
                .describe(
                  "Search by production role (e.g. 'painter', 'printmaker', 'after painting by'). " +
                  "Covers craft roles and relational attribution terms. " +
                  "For attribution qualifiers (workshop of, follower of, circle of), use attributionQualifier instead. " +
                  "Array values AND-combine — a work must carry every named role on the same production row, which is rarely satisfied (most works carry one role per part). " +
                  "To collect a union of roles (e.g. all 'after X by' variants), issue separate calls and merge client-side."
                ),
              attributionQualifier: stringOrArray()
                .optional()
                .describe(
                  "Filter by attribution qualifier. Full enumerated set (13 values, ordered by DB frequency): " +
                  "'primary', 'undetermined', 'after', 'secondary', 'possibly', 'attributed to', " +
                  "'circle of', 'workshop of', 'copyist of', 'manner of', 'follower of', 'falsification', 'free-form'. " +
                  "Mixes connoisseurship terms (workshop of, circle of, follower of, manner of, copyist of), " +
                  "editorial-confidence terms (attributed to, possibly, undetermined), and structural markers (primary, secondary, after, falsification, free-form). " +
                  "Combine with creator to narrow attribution (e.g. attributionQualifier: 'workshop of' + creator: 'Rembrandt')."
                ),
              expandPlaceHierarchy: z.preprocess(stripNullCoerceBool, z
                .boolean()
                .optional()
                .describe(
                  "When true, place searches (productionPlace, depictedPlace) " +
                  "expand to include sub-places in the administrative hierarchy. " +
                  "E.g. productionPlace: 'Netherlands' with expandPlaceHierarchy: true includes Amsterdam, Delft, etc. " +
                  "Expansion follows up to 3 levels of parent→child relationships. " +
                  "Requires a place filter — cannot be used alone."
                )),
              sameRowMatching: z.preprocess(stripNullCoerceBool, z
                .boolean()
                .optional()
                .describe(
                  "Constrain creator + productionRole to the *same* production row of the artwork (autograph detection). " +
                  "Without this flag, the two filters evaluate independently across production rows: a work matches if any row names the creator AND any other row carries the role — including reproductive prints and 19th-c. photographs catalogued under the master's name. " +
                  "Set true for 'making' roles (painter, draughtsman, print maker, etcher, engraver, etc.) when narrowing to autograph works by a named creator. " +
                  "Leave false (default) for 'relational' roles like 'after painting by' / 'after print by' — those want independence because the named creator is the *source*, not the maker of that row. " +
                  "Requires creator + productionRole both supplied. The creator+attributionQualifier same-row fix (connoisseurship qualifiers like 'after', 'workshop of', 'manner of') is always on and doesn't require this flag."
                )),
              heightRange: optMinStr()
                .optional()
                .describe(
                  "Height range in centimeters. Forms: '10-50' (between 10 and 50), '10-' (≥ 10), '-50' (≤ 50). " +
                  "Inclusive bounds. 0.0 sentinel values (meaning 'unknown') are excluded from upper-bound matches."
                ),
              widthRange: optMinStr()
                .optional()
                .describe(
                  "Width range in centimeters. Same form as heightRange ('10-50', '10-', '-50')."
                ),
              nearPlace: optMinStr()
                .optional()
                .describe(
                  "Search for artworks related to places near a named location (e.g. 'Leiden'). " +
                  "Supports multi-word place names with geo-disambiguation (e.g. 'Oude Kerk Amsterdam' resolves to the Oude Kerk in Amsterdam). " +
                  "Searches both depicted and production places within the specified radius."
                ),
              nearLat: z
                .number()
                .min(-90)
                .max(90)
                .optional()
                .describe(
                  "Latitude for coordinate-based proximity search (-90 to 90). Use with nearLon. " +
                  "Alternative to nearPlace for searching near arbitrary locations."
                ),
              nearLon: z
                .number()
                .min(-180)
                .max(180)
                .optional()
                .describe(
                  "Longitude for coordinate-based proximity search (-180 to 180). Use with nearLat."
                ),
              nearPlaceRadius: z
                .number()
                .min(0.1)
                .max(500)
                .default(25)
                .describe(
                  "Radius in kilometers for nearPlace or nearLat/nearLon search (0.1-500, default 25)."
                ),
            }
          : {}),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(TOOL_LIMITS.search_artwork.max)
          .default(TOOL_LIMITS.search_artwork.default)
          .describe(`Maximum results to return (1-${TOOL_LIMITS.search_artwork.max}, default ${TOOL_LIMITS.search_artwork.default}). All results include full metadata.`),
        offset: z.preprocess(stripNull, z.number().int().min(0).default(0).optional())
          .describe("Skip this many results (for pagination). Use with maxResults."),
        facets: z.preprocess(
          (v) => {
            if (v === true) return [...FACET_DIMENSIONS];
            if (v === false || v === null || v === undefined) return undefined;
            return v;
          },
          z.array(z.enum(FACET_DIMENSIONS)).optional(),
        ).describe(
            "Facet dimensions to compute when results are truncated. " +
            "Pass an array of dimension names (e.g. [\"theme\", \"rights\"]) to compute only those, " +
            "or true for all dimensions. " +
            `Available: ${FACET_DIMENSIONS.join(", ")}. ` +
            "Dimensions already filtered on are excluded automatically and reported in `warnings`."
          ),
        facetLimit: z.preprocess(stripNull, z.number().int().min(1).max(50).default(5).optional())
          .describe("Maximum entries per facet dimension (1–50, default 5)."),
        compact: z.preprocess(stripNullCoerceBool, z.boolean().default(false))
          .describe(
            "If true, returns only total count and IDs without resolving details (faster)."
          ),
        groupBy: z
          .enum(["parent"])
          .optional()
          .describe(
            "Collapse component records under their parent (sketchbook folios, album pages, print-series leaves). " +
            "When 'parent' is set, any child record that appears in the result alongside its parent is dropped, " +
            "and the parent gains a `groupedChildCount`. Only collapses when both child and parent match the query " +
            "— children whose parent isn't a hit remain in the result. Applied after the BM25 page is selected, " +
            "so a parent that ranks below the maxResults cutoff won't pull its children in. Closes #28.",
          ),
        sort: optMinStr()
          .optional()
          .describe(
            "Order results by a column (with optional direction). Forms: 'height', 'height:desc' (default), 'dateEarliest:asc'. " +
            "Overrides BM25 (text-match) and geo-proximity ordering when set. Cannot be used alone — needs at least one substantive filter.\n\n" +
            "Columns: " +
            "'height' / 'width' (cm — 95% / 94% coverage; 0.0 sentinels are folded to NULL and ordered last), " +
            "'dateEarliest' / 'dateLatest' (year — 99.9% coverage; bracket the dating range, useful for hedged datings like 'c. 1660–1665'), " +
            "'recordModified' (ISO date — 62% coverage; ~7 implausibly future-dated rows lead a 'desc' sort, ~2K pre-1990 rows lead an 'asc' sort).\n\n" +
            "Direction defaults to 'desc'. NULLs always sort last regardless of direction. " +
            "Examples: largest paintings → 'height:desc'; earliest works → 'dateEarliest:asc'; most recently catalogued → 'recordModified:desc'."
          ),
      }).strict(),
      ...withOutputSchema(SearchResultOutput),
    },
    withLogging("search_artwork", async (args) => {
      if (!vocabAvailable || !vocabDb) {
        return errorResponse(
          "search_artwork requires the vocabulary database. " +
          "Ensure VOCAB_DB_PATH or VOCAB_DB_URL is configured."
        );
      }

      const argsRecord = args as Record<string, unknown>;

      // At least one substantive filter required (prevent unfiltered full-collection scans).
      const hasAnyFilter = vocabParamKeys.some(k =>
          !MODIFIER_KEYS.has(k) && argsRecord[k] !== undefined
        ) || argsRecord["query"] !== undefined;
      if (!hasAnyFilter) {
        return errorResponse(
          "At least one search filter is required (imageAvailable, hasProvenance, expandPlaceHierarchy " +
          "are modifiers that cannot be used alone). " +
          "Add a filter like subject, creator, type, material, technique, depictedPerson, or creationDate. " +
          "For demographic queries (gender, birth/death place, profession), use search_persons → search_artwork({creator: <vocabId>}). " +
          "For concept-based search, try semantic_search instead."
        );
      }

      const vocabArgs: Record<string, unknown> = { maxResults: args.maxResults, offset: args.offset };
      for (const k of allVocabKeys) {
        if (argsRecord[k] !== undefined && !COMPOUND_PUBLIC_KEYS.has(k)) {
          vocabArgs[k] = argsRecord[k];
        }
      }
      if (args.facets) vocabArgs["facets"] = args.facets;
      if (args.facetLimit != null) vocabArgs["facetLimit"] = args.facetLimit;
      // query → title (vocab path searches title via title_all_text)
      if (argsRecord["query"]) {
        vocabArgs["title"] = argsRecord["query"];
      }
      // heightRange / widthRange → min/maxHeight, min/maxWidth
      const heightBounds = parseDimRange(argsRecord["heightRange"]);
      if (heightBounds) {
        if (heightBounds.min != null) vocabArgs["minHeight"] = heightBounds.min;
        if (heightBounds.max != null) vocabArgs["maxHeight"] = heightBounds.max;
      } else if (argsRecord["heightRange"] !== undefined) {
        return errorResponse(`Invalid heightRange "${argsRecord["heightRange"]}". Use forms like '10-50', '10-', or '-50'.`);
      }
      const widthBounds = parseDimRange(argsRecord["widthRange"]);
      if (widthBounds) {
        if (widthBounds.min != null) vocabArgs["minWidth"] = widthBounds.min;
        if (widthBounds.max != null) vocabArgs["maxWidth"] = widthBounds.max;
      } else if (argsRecord["widthRange"] !== undefined) {
        return errorResponse(`Invalid widthRange "${argsRecord["widthRange"]}". Use forms like '10-50', '10-', or '-50'.`);
      }
      // sort → sortBy + sortOrder
      const sortParsed = parseSortParam(argsRecord["sort"]);
      if (sortParsed) {
        vocabArgs["sortBy"] = sortParsed.sortBy;
        vocabArgs["sortOrder"] = sortParsed.sortOrder;
      } else if (argsRecord["sort"] !== undefined) {
        return errorResponse(
          `Invalid sort "${argsRecord["sort"]}". ` +
          `Use 'column' or 'column:asc|desc' where column is one of height, width, dateEarliest, dateLatest, recordModified.`
        );
      }

      // Split a search's wall-clock into facet-aggregation vs the rest ("main"), for #378.
      const recordSearchPhases = (timings: SearchTimings, tSearch: number) => {
        if (timings.facetMs === undefined) return;
        stats?.recordPhase("search_artwork", "facets", timings.facetMs);
        stats?.recordPhase("search_artwork", "main", Math.max(0, performance.now() - tSearch - timings.facetMs));
      };

      // Compact mode: return only IDs without enrichment
      if (args.compact) {
        const cTimings: SearchTimings = {};
        const tSearch = performance.now();
        const compactResult = vocabDb.searchCompact(vocabArgs as any, cTimings);
        recordSearchPhases(cTimings, tSearch);

        const header = (compactResult.totalResults != null
          ? `${compactResult.totalResults} results`
          : `${compactResult.ids.length} results`) + " (compact)";
        const textParts: string[] = [header];
        if (compactResult.facets) {
          addPercentages(compactResult.facets);
          textParts.push(formatFacets(compactResult.facets));
        }
        if (compactResult.ids.length) textParts.push(compactResult.ids.join(", "));
        const data: InferOutput<typeof SearchResultOutput> = compactResult;
        return structuredResponse(data, textParts.join("\n"));
      }

      const timings: SearchTimings = {};
      const tSearch = performance.now();
      const result = vocabDb.search(vocabArgs as any, timings);
      recordSearchPhases(timings, tSearch);

      // Suggest aboutActor when depictedPerson returns 0 results
      if (result.results.length === 0 && argsRecord.depictedPerson) {
        result.warnings = [...(result.warnings || []),
          `depictedPerson:"${argsRecord.depictedPerson}" matched no results. ` +
          `Try aboutActor for broader person matching (searches both depicted persons and creators).`];
      }

      // groupBy=parent: collapse children whose parent is also in the result set.
      // Structural fix for #28; replaces the prefix-string heuristic when the user opts in.
      let groupedAway = 0;
      if (args.groupBy === "parent" && result.results.length > 0) {
        const objectNumbers = result.results.map(r => r.objectNumber);
        const childToParent = vocabDb.findParentGroupings(objectNumbers);
        if (childToParent.size > 0) {
          const childCountByParent = new Map<string, number>();
          for (const parentObj of childToParent.values()) {
            childCountByParent.set(parentObj, (childCountByParent.get(parentObj) ?? 0) + 1);
          }
          const filtered: typeof result.results = [];
          for (const r of result.results) {
            if (childToParent.has(r.objectNumber)) {
              groupedAway++;
              continue;
            }
            const absorbed = childCountByParent.get(r.objectNumber);
            filtered.push(absorbed ? { ...r, groupedChildCount: absorbed } : r);
          }
          result.results = filtered;
        }
      }

      // Detect component-record clustering (sketchbook folios, album pages, etc.)
      // Skip when groupBy=parent already handled it structurally.
      if (args.groupBy !== "parent") {
        const clusterNote = detectComponentClustering(result.results.map(r => r.objectNumber));
        if (clusterNote) result.warnings = [...(result.warnings || []), clusterNote];
      } else if (groupedAway > 0) {
        result.warnings = [...(result.warnings || []),
          `groupBy=parent collapsed ${groupedAway} child record(s) into ${result.results.filter(r => "groupedChildCount" in r).length} parent(s).`];
      }

      const header = `${result.results.length} results` +
        (result.totalResults != null ? ` of ${result.totalResults} total` : '') +
        ` (vocabulary search)`;
      const textParts: string[] = [header];
      if (result.facets) {
        addPercentages(result.facets);
        textParts.push(formatFacets(result.facets));
      }
      textParts.push(...result.results.map((r, i) => formatSearchLine(r, i)));
      const structured: InferOutput<typeof SearchResultOutput> = result;
      return structuredResponse(structured, textParts.join("\n"));
    })
  );

  // ── search_persons ──────────────────────────────────────────────

  if (vocabAvailable) {
    const PersonSearchOutput = {
      totalResults: z.number().int().nonnegative(),
      persons: z.array(z.object({
        vocabId: z.string(),
        label: z.string(),
        labelEn: z.string().nullable(),
        labelNl: z.string().nullable(),
        birthYear: z.number().int().nullable(),
        deathYear: z.number().int().nullable(),
        gender: z.string().nullable(),
        wikidataId: z.string().nullable(),
        artworkCount: z.number().int().optional(),
      })),
      warnings: z.array(z.string()).optional(),
    };

    server.registerTool(
      "search_persons",
      {
        title: "Search Persons",
        annotations: ANN_READ_CLOSED,
        description:
          "Demographic/structural lookup of persons by gender, birth/death year or place, or profession; returns vocab IDs. " +
          "Returns vocab IDs to feed into search_artwork({creator: <vocabId>}) for works by them, " +
          "or search_artwork({aboutActor: <name>}) for works depicting them. " +
          "Two-step pattern: search_persons → search_artwork. " +
          "Examples: 'female impressionist painters born after 1850' or 'Dutch painters who died in Italy'.\n\n" +
          "Not for free-text concept queries — use semantic_search. " +
          "Not for filter-based artwork search by a known creator name — use search_artwork({creator: <name>}) directly.\n\n" +
          "By default restricts to persons with ≥1 artwork in the collection (~60K of ~290K). " +
          "Coverage note: demographic filters (gender, bornAfter, bornBefore) require person-enrichment on the vocabulary DB — they return zero rows on a freshly harvested DB without it, and undercount where enrichment is sparse. " +
          "The structural filters (birthPlace / deathPlace / profession) work on any harvest but resolve by pivoting through creator-mapped artworks, so on multi-creator works the artwork-level attribute leaks to co-creators — expect false positives (incl. 'anonymous'/'unknown' placeholders ranked high by output volume). " +
          "Treat all of these filtered lists as approximate, not authoritative cohorts. Name search is exact and unaffected.",
        inputSchema: z.object({
          name: optMinStr().optional()
            .describe("Phrase or token match against ~700K name variants (~290K persons). Tries exact phrase first, then token AND with stop-word stripping."),
          gender: optMinStr().optional()
            .describe("Categorical: 'female', 'male', or other normalised values. From person-enrichment, whose coverage is partial: returns 0 rows if enrichment is absent entirely, and undercounts where it is sparse — a missing match does not mean the person lacks the attribute, so don't treat the result count as the full population."),
          bornAfter: z.preprocess(stripNull, z.number().int().optional())
            .describe("Birth year ≥ this value. From person-enrichment, whose coverage is partial: returns 0 rows if enrichment is absent entirely, and undercounts where birth years are unrecorded — don't treat the result count as the full population."),
          bornBefore: z.preprocess(stripNull, z.number().int().optional())
            .describe("Birth year ≤ this value. From person-enrichment, whose coverage is partial: returns 0 rows if enrichment is absent entirely, and undercounts where birth years are unrecorded — don't treat the result count as the full population."),
          birthPlace: stringOrArray().optional()
            .describe("Place name (vocab + FTS match). Multi-value AND. Resolved by pivoting through the person's creator-mapped artworks. " +
              "Caveat: the place is an artwork-level attribute, not bound to a specific creator, so on multi-creator works (e.g. prints with designer + engraver + publisher) it leaks to co-creators who were NOT born there. " +
              "Expect false positives — including 'anonymous'/'unknown' placeholder agents ranked high by output volume — so treat the returned list as approximate, not an authoritative birthplace cohort."),
          deathPlace: stringOrArray().optional()
            .describe("Place name. Multi-value AND. Resolved by pivoting through the person's creator-mapped artworks. " +
              "Same caveat as birthPlace: the place is an artwork-level attribute, so on multi-creator works it leaks to co-creators who did not die there. " +
              "Expect false positives — treat the returned list as approximate, not authoritative."),
          profession: stringOrArray().optional()
            .describe("Profession (e.g. 'painter', 'engraver'). Multi-value AND. Resolved by pivoting through the person's creator-mapped artworks. " +
              "Same caveat as birthPlace: the profession is an artwork-level attribute, so on multi-creator works it leaks to co-creators who do not hold it. " +
              "Expect false positives — treat the returned list as approximate, not authoritative."),
          hasArtworks: z.preprocess(stripNullCoerceBool, z.boolean().optional().default(true))
            .describe("Restrict to persons appearing as creator on ≥1 artwork. Default true."),
          unused: z.preprocess(stripNullCoerceBool, z.boolean().optional())
            .describe("Restrict to persons with no link to any artwork in the published LOD — neither as a maker (creator) nor as a depicted subject — i.e. genuinely orphaned authority names for catalogue clean-up. Overrides hasArtworks when both are set. Caveat: 'unused' means no link in the public LOD harvest; a name unused here may still be linked internally, so treat results as cleanup candidates, not confirmed orphans."),
          maxResults: z.number().int().min(1).max(TOOL_LIMITS.search_persons.max).default(TOOL_LIMITS.search_persons.default)
            .describe(`Maximum persons to return (1-${TOOL_LIMITS.search_persons.max}, default ${TOOL_LIMITS.search_persons.default}).`),
          offset: z.preprocess(stripNull, z.number().int().min(0).default(0).optional())
            .describe("Skip this many results (for pagination)."),
        }).strict(),
        ...withOutputSchema(PersonSearchOutput),
      },
      withLogging("search_persons", async (args) => {
        if (!vocabDb) {
          return errorResponse("search_persons requires the vocabulary database.");
        }
        const a = args as Record<string, unknown>;
        const params: PersonSearchParams = {};
        if (a.name) params.name = a.name as string;
        if (a.gender) params.gender = a.gender as string;
        if (a.bornAfter != null) params.bornAfter = a.bornAfter as number;
        if (a.bornBefore != null) params.bornBefore = a.bornBefore as number;
        if (a.birthPlace) params.birthPlace = a.birthPlace as string | string[];
        if (a.deathPlace) params.deathPlace = a.deathPlace as string | string[];
        if (a.profession) params.profession = a.profession as string | string[];
        if (a.hasArtworks != null) params.hasArtworks = a.hasArtworks as boolean;
        if (a.unused != null) params.unused = a.unused as boolean;
        params.maxResults = a.maxResults as number ?? 25;
        if (a.offset != null) params.offset = a.offset as number;

        const result = vocabDb.searchPersons(params);

        const lines: string[] = [];
        lines.push(`${result.totalResults} person${result.totalResults === 1 ? "" : "s"} found`);
        if (result.totalResults > result.persons.length) {
          lines.push(`Showing ${result.persons.length} (offset ${params.offset ?? 0}).`);
        }
        for (let i = 0; i < result.persons.length; i++) {
          const p = result.persons[i];
          let line = `${i + 1}. ${p.label} (${p.vocabId})`;
          const lifespan = (p.birthYear || p.deathYear) ? ` ${p.birthYear ?? "?"}–${p.deathYear ?? "?"}` : "";
          line += lifespan;
          if (p.gender) line += ` · ${p.gender}`;
          if (p.artworkCount != null) line += ` · ${p.artworkCount} works`;
          if (p.wikidataId) line += ` · Q${p.wikidataId.replace(/^Q/, "")}`;
          lines.push(line);
        }
        return structuredResponse(result, lines.join("\n"));
      })
    );
  }
}
