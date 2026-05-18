// Per-tool fixture inputs for the payload-redundancy audit.
//
// Design principles:
//  1. Where possible, reuse the same `objectNumber` across tools so that
//     cross-tool value-alias detection has shared anchors (the same
//     concrete fact returned under different field names across tools).
//  2. Cover both high-population artworks (Pieneman, Night Watch) and
//     simpler ones (Vermeer's Milkmaid) so the audit isn't biased by a
//     single shape of catalogue record.
//  3. Tools that mutate state (navigate_viewer) or are app-internal
//     (remount_viewer, poll_viewer_commands) are deliberately skipped.
//
// Each fixture has:
//   - tool: MCP tool name
//   - label: short identifier for output filenames
//   - args: arguments object passed to callTool
//   - anchor: optional objectNumber for cross-tool alias detection
//   - skipInspectField: optional path that should be excluded from byte
//                       accounting (e.g. base64 image bytes)

export const ANCHOR_PIENEMAN = "SK-A-1115";   // Battle of Waterloo — verbose extent
export const ANCHOR_NIGHTWATCH = "SK-C-5";    // Night Watch — historical caveats
export const ANCHOR_MILKMAID = "SK-A-2344";   // Milkmaid — smaller, simpler record

export const FIXTURES = [
  // ── search_artwork ────────────────────────────────────────────────
  {
    tool: "search_artwork",
    label: "creator-rembrandt",
    args: { creator: "Rembrandt van Rijn", maxResults: 3 },
  },
  {
    tool: "search_artwork",
    label: "type-painting-amsterdam",
    args: { type: "painting", productionPlace: "Amsterdam", maxResults: 3 },
  },

  // ── semantic_search ───────────────────────────────────────────────
  {
    tool: "semantic_search",
    label: "ships-at-sea",
    args: { query: "ships at sea in a storm", maxResults: 3 },
  },

  // ── find_similar ──────────────────────────────────────────────────
  {
    tool: "find_similar",
    label: "pieneman",
    args: { objectNumber: ANCHOR_PIENEMAN, maxResults: 3 },
    anchor: ANCHOR_PIENEMAN,
  },

  // ── search_persons ────────────────────────────────────────────────
  {
    tool: "search_persons",
    label: "rembrandt",
    args: { name: "Rembrandt", maxResults: 3 },
  },

  // ── search_provenance ─────────────────────────────────────────────
  {
    tool: "search_provenance",
    label: "wellington",
    args: { party: "Wellington" },
  },

  // ── get_artwork_details (3 anchors) ───────────────────────────────
  {
    tool: "get_artwork_details",
    label: "pieneman",
    args: { objectNumber: ANCHOR_PIENEMAN },
    anchor: ANCHOR_PIENEMAN,
  },
  {
    tool: "get_artwork_details",
    label: "nightwatch",
    args: { objectNumber: ANCHOR_NIGHTWATCH },
    anchor: ANCHOR_NIGHTWATCH,
  },
  {
    tool: "get_artwork_details",
    label: "milkmaid",
    args: { objectNumber: ANCHOR_MILKMAID },
    anchor: ANCHOR_MILKMAID,
  },

  // ── get_artwork_image (3 anchors — cross-tool alias source) ───────
  {
    tool: "get_artwork_image",
    label: "pieneman",
    args: { objectNumber: ANCHOR_PIENEMAN },
    anchor: ANCHOR_PIENEMAN,
  },
  {
    tool: "get_artwork_image",
    label: "nightwatch",
    args: { objectNumber: ANCHOR_NIGHTWATCH },
    anchor: ANCHOR_NIGHTWATCH,
  },
  {
    tool: "get_artwork_image",
    label: "milkmaid",
    args: { objectNumber: ANCHOR_MILKMAID },
    anchor: ANCHOR_MILKMAID,
  },

  // ── inspect_artwork_image (small region to keep base64 payload small) ──
  // Image bytes are accounted for separately to avoid skewing byte stats.
  {
    tool: "inspect_artwork_image",
    label: "pieneman-small-region",
    args: { objectNumber: ANCHOR_PIENEMAN, region: "pct:40,40,20,20", size: 400 },
    anchor: ANCHOR_PIENEMAN,
    excludeFields: ["image", "imageBase64", "data", "imageBytes"],
  },

  // ── list_curated_sets ─────────────────────────────────────────────
  {
    tool: "list_curated_sets",
    label: "default",
    args: {},
  },

  // ── browse_set ────────────────────────────────────────────────────
  {
    tool: "browse_set",
    label: "top100",
    args: { setSpec: "260213", maxResults: 5 },
  },

  // ── collection_stats ──────────────────────────────────────────────
  {
    tool: "collection_stats",
    label: "by-type",
    args: { dimension: "type", topN: 10 },
  },

  // ── get_recent_changes ────────────────────────────────────────────
  {
    tool: "get_recent_changes",
    label: "recent",
    args: { from: "2025-12-01", maxResults: 3 },
  },
];

// Tools we deliberately do not exercise (app-only, hidden, or
// require live viewer state). Documented here so the audit report
// can call them out explicitly rather than leaving the reader to
// wonder why they're absent.
export const SKIPPED_TOOLS = {
  navigate_viewer: "requires live viewUUID; payload is viewer-state, not facts",
  remount_viewer: "hidden app-only tool (visibility:['app'])",
  poll_viewer_commands: "hidden app-only tool (visibility:['app'])",
};
