import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VocabularyDb, STATS_DIMENSION_NAMES, type CollectionStatsParams } from "../../api/VocabularyDb.js";
import { EmbeddingsDb } from "../../api/EmbeddingsDb.js";
import { EmbeddingModel } from "../../api/EmbeddingModel.js";
import { UsageStats } from "../../utils/UsageStats.js";
import {
  ANN_READ_CLOSED,
  TOOL_LIMITS,
  stripNull,
  stripNullCoerceBool,
  optStr,
  structuredResponse,
  withOutputSchema,
  canonicalInputKey,
  createLogger,
} from "../helpers.js";
import { collectionStatsCache } from "../state.js";

const CollectionStatsOutput = {
  dimension: z.string(),
  total: z.number().int().describe("Artwork pool size after filters (always artwork-scoped, even for provenance dimensions)."),
  denominatorScope: z.literal("artwork")
    .describe("Explicit signal that count/total is artwork-share. Provenance dimensions are NOT event-share or party-share."),
  multiValued: z.boolean()
    .describe("True when one artwork can match multiple buckets (so Σ(percentage) can exceed 100%). " +
      "Single-valued dimensions (century, decade, height, width, decadeModified) sum to ≤100% — the residual is coverage.withoutBucket."),
  groupingKey: z.enum(["label", "entity", "computed_bucket"])
    .describe("How entries are collapsed: 'label' (vocab display label — Rembrandt entities may merge by name), " +
      "'entity' (exhibition_id — distinct entities even if titles collide), " +
      "'computed_bucket' (SELECT-time expression — decade/century/cm-bin/decadeModified)."),
  ordering: z.enum(["count_desc", "label_asc"])
    .describe("Effective ordering of entries. Defaults vary by dimension; override via sortBy."),
  bucketUnit: z.enum(["year", "cm"]).optional()
    .describe("Unit for bucketWidth. Present only for binned dimensions."),
  bucketWidth: z.number().int().optional()
    .describe("Effective bin width. Echoes the binWidth parameter for decade/provenanceDecade/height/width. " +
      "Hardcoded 10 for decadeModified, 100 for century."),
  bucketDomain: z.object({
    min: z.number().int().optional(),
    maxExclusive: z.number().int().optional(),
  }).optional().describe("Inclusive-min / exclusive-max window for clamped dimensions. " +
    "decadeModified clamps to {min: 1990, maxExclusive: 2030}; rows outside the window contribute to coverage.withoutBucket."),
  coverage: z.object({
    withBucket: z.number().int().describe("Artworks in the filtered pool with ≥1 row in this dimension's source."),
    withoutBucket: z.number().int().describe("Artworks in the filtered pool with no value in this dimension. Explains the residual to 100% on single-valued dims."),
  }).describe("withBucket + withoutBucket === total. Lets consumers reconstruct missing-data and clamp residuals without per-dim NULL knowledge."),
  totalBuckets: z.number().int()
    .describe("Number of distinct buckets in the filtered pool (under this dimension's groupingKey). " +
      "Named totalBuckets (not totalDistinct) because grouping is not always label-based — exhibition collapses on entity, ordinal dims on computed buckets."),
  offset: z.number().int(),
  entries: z.array(z.object({
    label: z.union([z.string(), z.number()]),
    count: z.number().int(),
    percentage: z.number().optional(),
  })),
  appliedFilters: z.record(z.string(), z.unknown())
    .describe("Round-trip echo of accepted filter args (excludes control params like topN/offset/binWidth/sortBy/dimension)."),
  warnings: z.array(z.string()).optional(),
};

export function registerStatsTools(
  server: McpServer,
  vocabDb: VocabularyDb | null,
  _embeddingsDb: EmbeddingsDb | null,
  _embeddingModel: EmbeddingModel | null,
  withLogging: ReturnType<typeof createLogger>,
  _stats?: UsageStats
): void {
  const vocabAvailable = vocabDb?.available ?? false;

  if (vocabAvailable) {
    const STATS_DIMENSIONS = STATS_DIMENSION_NAMES;

    server.registerTool(
      "collection_stats",
      {
        title: "Collection-wide Aggregate Counts (Distributions, Histograms, Statistics)",
        annotations: ANN_READ_CLOSED,
        description:
          "Group-by breakdown over one structured dimension (type, decade, place, creator) — counts, percentages, histograms. " +
          "Covers totals, summaries, and group-by / count-by / distribution-of / statistics-over queries across the Rijksmuseum collection. " +
          "Returns formatted text tables + structured output mirroring the same data (denominator/grouping/coverage semantics disclosed in the schema). " +
          "Not for individual artwork lookup — use get_artwork_details. Not for similarity — use find_similar.\n\n" +
          "Examples:\n" +
          "- \"Transfer type distribution for Rembrandt\" → dimension='transferType', creator='Rembrandt'\n" +
          "- \"Sales by decade 1600–1900\" → dimension='provenanceDecade', transferType='sale', provenanceDateFrom=1600, provenanceDateTo=1900\n" +
          "- \"How many artworks have LLM-mediated interpretations?\" → dimension='categoryMethod'\n" +
          "- \"Type breakdown of Rembrandt's autograph paintings\" → dimension='type', creator='Rembrandt van Rijn', productionRole='painter', sameRowMatching=true\n" +
          "- \"Workshop-of-Rembrandt works by type\" → dimension='type', creator='Rembrandt van Rijn', attributionQualifier='workshop of'\n\n" +
          "Artwork dimensions: type, material, technique, creator, productionRole (making/reproductive role), profession, depictedPerson, depictedPlace, " +
          "productionPlace, birthPlace (creator birth place), deathPlace (creator death place), century, decade, height, width, " +
          "gender (creator gender: female/male/unknown — groups artworks by creator gender via creator-mapping join), " +
          "creatorBirthDecade / creatorBirthCentury (cohort dims bucketed by creator birth year), " +
          "placeType (production place type — country/city/region/etc.), " +
          "theme (thematic vocab — labels in NL until backfill), sourceType (cataloguing-channel taxonomy — 6 values), " +
          "exhibition (top exhibitions by member count), decadeModified (record_modified bucketed by decade, clamped to 1990–2030).\n" +
          "Provenance dimensions: transferType, transferCategory, provenanceDecade, provenanceLocation, party, partyPosition, partyRole " +
          "(verb-derived role: collector/buyer/recipient/heir/donor vs the normalised owner/non-owner partyPosition), " +
          "currency, categoryMethod, positionMethod, parseMethod.\n\n" +
          "Filters from both domains combine freely. Artwork filters narrow the artwork set; provenance filters " +
          "further restrict to artworks matching those provenance criteria. Provenance event-level filters " +
          "(transferType + provenanceLocation + provenanceDateFrom/To + categoryMethod + parseMethod + unsold/uncertain/gap/crossRef) " +
          "compose on the same event row; party-level filters (party + positionMethod + partyRole) compose on the same party row. " +
          "For demographic-filtered counts (e.g. female artists by century), use gender='female' directly or run search_persons to get vocab IDs, then pass them as creator.",
        inputSchema: z.object({
          dimension: z.enum(STATS_DIMENSIONS as unknown as [string, ...string[]])
            .describe("What to count/group by."),
          topN: z.preprocess(stripNull, z.number().int().min(1).max(TOOL_LIMITS.collection_stats.max).default(TOOL_LIMITS.collection_stats.default).optional())
            .describe(`Maximum entries to return (1–${TOOL_LIMITS.collection_stats.max}, default ${TOOL_LIMITS.collection_stats.default}).`),
          offset: z.preprocess(stripNull, z.number().int().min(0).default(0).optional())
            .describe("Skip this many entries (for pagination). Use with topN."),
          binWidth: z.preprocess(stripNull, z.number().int().min(1).default(10).optional())
            .describe("Bin width for binned dimensions. Unit follows the dimension's natural unit: years for decade/provenanceDecade (default 10), centimeters for height/width (default 10). " +
              "century is hardcoded to 100-year buckets; decadeModified is hardcoded to 10-year buckets — binWidth has no effect on either."),
          sortBy: z.enum(["count", "label"]).optional()
            .describe("Override the dimension's default ordering. " +
              "Defaults: count for vocab/exhibition dims and century; label for decade/decadeModified/height/width/provenanceDecade. " +
              "Echoed back as `ordering` in structured output."),
          // Artwork filters
          type: optStr().describe("Filter to artworks of this type (e.g. 'painting', 'print')."),
          material: optStr().describe("Filter to artworks with this material."),
          technique: optStr().describe("Filter to artworks with this technique."),
          creator: optStr().describe("Filter to artworks by this creator (partial match)."),
          productionPlace: optStr().describe("Filter to artworks produced in this place (partial match). Spans both the Linked Art production-place field and the OAI-PMH spatial field. Areal places (continents/oceans/empires) are excluded from depictedPlace/productionPlace rollups to avoid centroid domination."),
          depictedPerson: optStr().describe("Filter to artworks depicting this person (partial match)."),
          depictedPlace: optStr().describe("Filter to artworks depicting this place (partial match). Areal places (continents/oceans/empires) are excluded from depictedPlace/productionPlace rollups."),
          subject: optStr().describe("Filter to artworks with this subject (partial match on Iconclass labels)."),
          iconclass: optStr().describe("Filter by exact Iconclass notation code (e.g. '73D82')."),
          collectionSet: optStr().describe("Filter to artworks in this curated set (partial match on set name)."),
          theme: optStr().describe("Filter to artworks tagged with this curatorial theme (partial match)."),
          sourceType: optStr().describe("Filter by source-channel taxonomy: 'designs', 'drawings', 'paintings', 'prints (visual works)', 'sculpture (visual works)', 'photographs'."),
          // Attribution scoping — mirrors search_artwork. Same-row matching with creator
          // is automatic for attributionQualifier (connoisseurship terms) and opt-in via
          // sameRowMatching for productionRole (making vs reproductive roles).
          attributionQualifier: optStr()
            .describe(
              "Filter by attribution qualifier. Values: 'primary', 'undetermined', 'after', " +
              "'secondary', 'possibly', 'attributed to', 'circle of', 'workshop of', 'copyist of', " +
              "'manner of', 'follower of', 'falsification', 'free-form'. " +
              "Combine with creator for autograph/connoisseurship narrowing — same-row matching is enforced automatically " +
              "(e.g. attributionQualifier='workshop of' + creator='Rembrandt' counts only works where 'workshop of' sits on Rembrandt's row, not on any other creator's row of the same artwork)."
            ),
          productionRole: optStr()
            .describe(
              "Filter by production role (e.g. 'painter', 'draughtsman', 'print maker', 'after painting by'). " +
              "Combine with creator + sameRowMatching=true for autograph narrowing on making roles."
            ),
          sameRowMatching: z.preprocess(stripNullCoerceBool, z.boolean().optional())
            .describe(
              "Constrain creator + productionRole to the *same* production row (autograph detection). " +
              "Required for accurate autograph counts: without it, productionRole matches independently of creator, inflating counts with reproductive works catalogued under the master's name. " +
              "Set true for making roles (painter, draughtsman, print maker); leave default-false for 'after X by' relational roles. " +
              "The creator+attributionQualifier same-row fix is always on and doesn't require this flag."
            ),
          imageAvailable: z.preprocess(stripNullCoerceBool, z.boolean().optional())
            .describe("Filter by digitisation: true = only artworks with a digital image, false = only those without."),
          creationDateFrom: z.preprocess(stripNull, z.number().int().optional())
            .describe("Earliest artwork creation year (inclusive). For century buckets, the label is the start year (label=1600 means the 17th century)."),
          creationDateTo: z.preprocess(stripNull, z.number().int().optional())
            .describe("Latest artwork creation year (inclusive)."),
          // Provenance filters — names mirror their dimension counterparts. All filters tagged
          // [events] compose on the same event row; [parties] filters compose on the same party row.
          hasProvenance: z.preprocess(stripNullCoerceBool, z.boolean().optional())
            .describe("If true, restrict to artworks with provenance records (~48K of 832K)."),
          transferType: optStr().describe("[events] Filter to artworks with at least one provenance event of this transfer type (e.g. 'sale', 'confiscation')."),
          provenanceLocation: optStr().describe("[events] Filter to artworks with at least one provenance event in this location (partial match)."),
          party: optStr().describe("[parties] Filter to artworks involving this party/collector (partial match)."),
          provenanceDateFrom: z.preprocess(stripNull, z.number().int().optional())
            .describe("[events] Earliest provenance event year (inclusive)."),
          provenanceDateTo: z.preprocess(stripNull, z.number().int().optional())
            .describe("[events] Latest provenance event year (inclusive)."),
          categoryMethod: optStr().describe("[events] Filter by category method (e.g. 'llm_enrichment')."),
          positionMethod: optStr().describe("[parties] Filter by position method (e.g. 'llm_enrichment')."),
          // Tier 1 (#320): creator-demographic vocab filters
          profession: optStr().describe("Filter to artworks by a creator with this profession (partial match on vocab label)."),
          birthPlace: optStr().describe("Filter to artworks by a creator born in this place (partial match)."),
          deathPlace: optStr().describe("Filter to artworks by a creator who died in this place (partial match)."),
          // Tier 2 (#320): gender + cohort
          gender: optStr().describe("Filter by creator gender (e.g. 'female', 'male', 'unknown'). Restricts to artworks with ≥1 creator-mapped person of that gender."),
          // Tier 3 (#320): production place type
          placeType: optStr().describe("Filter to artworks whose production place has this placetype. Accepts a human label exactly as shown in the placeType dimension breakdown (e.g. 'city', 'inhabited places', 'countries (sovereign states)') or a raw authority URI (Getty AAT / Wikidata)."),
          // has* boolean predicates (#320)
          hasInscription: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("Filter by presence of inscription text."),
          hasNarrative: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("Filter by presence of curatorial narrative text."),
          hasDimensions: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("Filter by presence of physical dimensions (height or width)."),
          hasExhibitions: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("Filter by participation in any recorded exhibition."),
          hasExternalIds: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("Filter by presence of external authority identifiers (e.g. Wikidata, RKD)."),
          hasAltNames: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("Filter by presence of alternative names on any linked vocabulary entity."),
          hasParent: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("Filter by membership in a parent work (series/album/portfolio)."),
          hasExaminations: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("Filter by presence of technical examination records."),
          hasModifications: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("Filter by presence of recorded modifications/restorations."),
          hasWikidataCreator: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("Filter by presence of a Wikidata-linked creator."),
          // Step 4 (#320): exhibition filter
          exhibition: optStr().describe("Filter to artworks in a specific exhibition (partial match on exhibition title)."),
          // Tier 2.5 (#320): parseMethod + event boolean flags
          parseMethod: optStr().describe("[events] Filter by provenance parse method (e.g. 'peg', 'regex_fallback', 'llm_structural')."),
          unsold: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("[events] Filter to events flagged as unsold (lot passed/withdrawn)."),
          uncertain: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("[events] Filter to events with uncertain dating or attribution."),
          gap: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("[events] Filter to events that represent a provenance gap."),
          crossRef: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("[events] Filter to cross-reference events (is_cross_ref=true)."),
          // Tier 2.6 (#320): party role filter
          partyRole: optStr().describe("[parties] Filter by party role — verb-derived role label (e.g. 'collector', 'buyer', 'recipient', 'heir', 'donor'). Distinct from partyPosition (normalised owner/non-owner)."),
        }).strict(),
        ...withOutputSchema(CollectionStatsOutput),
      },
      withLogging("collection_stats", async (args: Record<string, unknown>) => {
        const params: CollectionStatsParams = {
          dimension: args.dimension as string,
        };
        if (args.topN != null) params.topN = args.topN as number;
        if (args.offset != null) params.offset = args.offset as number;
        if (args.binWidth != null) params.binWidth = args.binWidth as number;
        if (args.sortBy) params.sortBy = args.sortBy as "count" | "label";
        if (args.type) params.type = args.type as string;
        if (args.material) params.material = args.material as string;
        if (args.technique) params.technique = args.technique as string;
        if (args.creator) params.creator = args.creator as string;
        if (args.productionPlace) params.productionPlace = args.productionPlace as string;
        if (args.depictedPerson) params.depictedPerson = args.depictedPerson as string;
        if (args.depictedPlace) params.depictedPlace = args.depictedPlace as string;
        if (args.subject) params.subject = args.subject as string;
        if (args.iconclass) params.iconclass = args.iconclass as string;
        if (args.collectionSet) params.collectionSet = args.collectionSet as string;
        if (args.theme) params.theme = args.theme as string;
        if (args.sourceType) params.sourceType = args.sourceType as string;
        if (args.attributionQualifier) params.attributionQualifier = args.attributionQualifier as string;
        if (args.productionRole) params.productionRole = args.productionRole as string;
        if (args.sameRowMatching != null) params.sameRowMatching = args.sameRowMatching as boolean;
        if (args.imageAvailable != null) params.imageAvailable = args.imageAvailable as boolean;
        if (args.creationDateFrom != null) params.creationDateFrom = args.creationDateFrom as number;
        if (args.creationDateTo != null) params.creationDateTo = args.creationDateTo as number;
        if (args.hasProvenance != null) params.hasProvenance = args.hasProvenance as boolean;
        if (args.transferType) params.transferType = args.transferType as string;
        if (args.provenanceLocation) params.provenanceLocation = args.provenanceLocation as string;
        if (args.party) params.party = args.party as string;
        if (args.provenanceDateFrom != null) params.provenanceDateFrom = args.provenanceDateFrom as number;
        if (args.provenanceDateTo != null) params.provenanceDateTo = args.provenanceDateTo as number;
        if (args.categoryMethod) params.categoryMethod = args.categoryMethod as string;
        if (args.positionMethod) params.positionMethod = args.positionMethod as string;
        // Tier 1 (#320)
        if (args.profession) params.profession = args.profession as string;
        if (args.birthPlace) params.birthPlace = args.birthPlace as string;
        if (args.deathPlace) params.deathPlace = args.deathPlace as string;
        // Tier 2 (#320)
        if (args.gender) params.gender = args.gender as string;
        // Tier 3 (#320)
        if (args.placeType) params.placeType = args.placeType as string;
        // has* (#320)
        if (args.hasInscription  != null) params.hasInscription  = args.hasInscription  as boolean;
        if (args.hasNarrative    != null) params.hasNarrative    = args.hasNarrative    as boolean;
        if (args.hasDimensions   != null) params.hasDimensions   = args.hasDimensions   as boolean;
        if (args.hasExhibitions  != null) params.hasExhibitions  = args.hasExhibitions  as boolean;
        if (args.hasExternalIds  != null) params.hasExternalIds  = args.hasExternalIds  as boolean;
        if (args.hasAltNames     != null) params.hasAltNames     = args.hasAltNames     as boolean;
        if (args.hasParent       != null) params.hasParent       = args.hasParent       as boolean;
        if (args.hasExaminations != null) params.hasExaminations = args.hasExaminations as boolean;
        if (args.hasModifications!= null) params.hasModifications= args.hasModifications as boolean;
        if (args.hasWikidataCreator != null) params.hasWikidataCreator = args.hasWikidataCreator as boolean;
        // Step 4 (#320)
        if (args.exhibition) params.exhibition = args.exhibition as string;
        // Tier 2.5 (#320)
        if (args.parseMethod) params.parseMethod = args.parseMethod as string;
        if (args.unsold    != null) params.unsold    = args.unsold    as boolean;
        if (args.uncertain != null) params.uncertain = args.uncertain as boolean;
        if (args.gap       != null) params.gap       = args.gap       as boolean;
        if (args.crossRef  != null) params.crossRef  = args.crossRef  as boolean;
        // Tier 2.6 (#320)
        if (args.partyRole) params.partyRole = args.partyRole as string;

        // #378 Step 4: cache the (synchronous) stats result keyed on DB build-id + params.
        // No in-flight de-dup needed — computeCollectionStats blocks the event loop, so two
        // identical concurrent calls can't interleave (the first populates the cache).
        const cacheKey = `${vocabDb!.buildId}|${canonicalInputKey(params)}`;
        let result = collectionStatsCache.get(cacheKey);
        if (result === undefined) {
          result = vocabDb!.computeCollectionStats(params);
          collectionStatsCache.set(cacheKey, result);
        }

        // Format as text table
        const lines: string[] = [];
        const filterParts: string[] = [];
        if (params.type) filterParts.push(`type=${params.type}`);
        if (params.material) filterParts.push(`material=${params.material}`);
        if (params.technique) filterParts.push(`technique=${params.technique}`);
        if (params.creator) filterParts.push(`creator=${params.creator}`);
        if (params.productionPlace) filterParts.push(`productionPlace=${params.productionPlace}`);
        if (params.depictedPerson) filterParts.push(`depictedPerson=${params.depictedPerson}`);
        if (params.depictedPlace) filterParts.push(`depictedPlace=${params.depictedPlace}`);
        if (params.subject) filterParts.push(`subject=${params.subject}`);
        if (params.iconclass) filterParts.push(`iconclass=${params.iconclass}`);
        if (params.collectionSet) filterParts.push(`collectionSet=${params.collectionSet}`);
        if (params.theme) filterParts.push(`theme=${params.theme}`);
        if (params.sourceType) filterParts.push(`sourceType=${params.sourceType}`);
        if (params.attributionQualifier) filterParts.push(`attributionQualifier=${params.attributionQualifier}`);
        if (params.productionRole) filterParts.push(`productionRole=${params.productionRole}`);
        if (params.sameRowMatching) filterParts.push("sameRowMatching");
        if (params.imageAvailable != null) filterParts.push(`imageAvailable=${params.imageAvailable}`);
        if (params.creationDateFrom != null || params.creationDateTo != null) {
          filterParts.push(`created ${params.creationDateFrom ?? "..."}–${params.creationDateTo ?? "..."}`);
        }
        if (params.hasProvenance) filterParts.push("hasProvenance");
        if (params.transferType) filterParts.push(`transferType=${params.transferType}`);
        if (params.provenanceLocation) filterParts.push(`provenanceLocation=${params.provenanceLocation}`);
        if (params.party) filterParts.push(`party=${params.party}`);
        if (params.provenanceDateFrom != null || params.provenanceDateTo != null) {
          filterParts.push(`provenance ${params.provenanceDateFrom ?? "..."}–${params.provenanceDateTo ?? "..."}`);
        }
        if (params.categoryMethod) filterParts.push(`categoryMethod=${params.categoryMethod}`);
        if (params.positionMethod) filterParts.push(`positionMethod=${params.positionMethod}`);
        if (params.profession) filterParts.push(`profession=${params.profession}`);
        if (params.birthPlace) filterParts.push(`birthPlace=${params.birthPlace}`);
        if (params.deathPlace) filterParts.push(`deathPlace=${params.deathPlace}`);
        if (params.gender) filterParts.push(`gender=${params.gender}`);
        if (params.placeType) filterParts.push(`placeType=${params.placeType}`);
        if (params.hasInscription != null) filterParts.push(`hasInscription=${params.hasInscription}`);
        if (params.hasNarrative != null) filterParts.push(`hasNarrative=${params.hasNarrative}`);
        if (params.hasDimensions != null) filterParts.push(`hasDimensions=${params.hasDimensions}`);
        if (params.hasExhibitions != null) filterParts.push(`hasExhibitions=${params.hasExhibitions}`);
        if (params.hasExternalIds != null) filterParts.push(`hasExternalIds=${params.hasExternalIds}`);
        if (params.hasAltNames != null) filterParts.push(`hasAltNames=${params.hasAltNames}`);
        if (params.hasParent != null) filterParts.push(`hasParent=${params.hasParent}`);
        if (params.hasExaminations != null) filterParts.push(`hasExaminations=${params.hasExaminations}`);
        if (params.hasModifications != null) filterParts.push(`hasModifications=${params.hasModifications}`);
        if (params.hasWikidataCreator != null) filterParts.push(`hasWikidataCreator=${params.hasWikidataCreator}`);
        if (params.exhibition) filterParts.push(`exhibition=${params.exhibition}`);
        if (params.parseMethod) filterParts.push(`parseMethod=${params.parseMethod}`);
        if (params.unsold != null) filterParts.push(`unsold=${params.unsold}`);
        if (params.uncertain != null) filterParts.push(`uncertain=${params.uncertain}`);
        if (params.gap != null) filterParts.push(`gap=${params.gap}`);
        if (params.crossRef != null) filterParts.push(`crossRef=${params.crossRef}`);
        if (params.partyRole) filterParts.push(`partyRole=${params.partyRole}`);

        const filterStr = filterParts.length > 0 ? ` (${filterParts.join(", ")})` : "";
        lines.push(`${result.dimension} distribution${filterStr}:`);
        lines.push(`Total artworks: ${result.total.toLocaleString()}`);
        if (result.multiValued && result.entries.length > 0) {
          lines.push("(multi-valued: artworks can match multiple buckets, so percentages can sum to >100%)");
        }
        if (result.bucketDomain && result.coverage.withoutBucket > 0) {
          const min = result.bucketDomain.min;
          const max = result.bucketDomain.maxExclusive;
          if (min != null && max != null) {
            lines.push(`(window: ${min}–${max - 1}; ${result.coverage.withoutBucket.toLocaleString()} artworks outside this range are excluded)`);
          }
        }
        if (result.totalBuckets > result.entries.length + result.offset) {
          const from = result.offset + 1;
          const to = result.offset + result.entries.length;
          lines.push(`Showing entries ${from}–${to} of ${result.totalBuckets} distinct ${result.groupingKey === "computed_bucket" ? "buckets" : "values"}`);
        }
        lines.push("");

        if (result.entries.length === 0) {
          lines.push("  (no data)");
        } else {
          const maxLabel = Math.max(...result.entries.map(e => String(e.label).length));
          const maxCount = Math.max(...result.entries.map(e => e.count.toLocaleString().length));
          for (const e of result.entries) {
            const pct = e.percentage != null ? `  (${e.percentage.toFixed(1)}%)` : "";
            lines.push(`  ${String(e.label).padEnd(maxLabel)}  ${e.count.toLocaleString().padStart(maxCount)}${pct}`);
          }
        }

        return structuredResponse(result, lines.join("\n"));
      })
    );
  }
}
