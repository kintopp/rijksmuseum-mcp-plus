import labels from "./placetype-labels.json" with { type: "json" };

/**
 * URI → human-readable English label for production-place placetypes (Getty AAT /
 * Wikidata authority URIs), used by the collection_stats `placeType` dimension.
 * Curated head only; the long tail falls back to the raw URI. Regenerate after a
 * harvest — see plan 027 Maintenance notes for the recipe.
 */
export const PLACETYPE_LABELS: Record<string, string> = labels as Record<string, string>;

// Reverse index: lowercased label → the URI(s) sharing it. One label *could* map to
// several authority URIs (none do in the current curated head, but keep the array
// shape so the filter stays correct if the tail later collides).
const LABEL_TO_URIS = new Map<string, string[]>();
for (const [uri, label] of Object.entries(PLACETYPE_LABELS)) {
  const key = label.toLowerCase();
  const arr = LABEL_TO_URIS.get(key);
  if (arr) arr.push(uri);
  else LABEL_TO_URIS.set(key, [uri]);
}

/** Resolve a placetype authority URI to its English label; unknown URIs pass through unchanged. */
export function labelForPlacetype(uri: string): string {
  return PLACETYPE_LABELS[uri] ?? uri;
}

/**
 * Resolve a human label (case-insensitive) to the authority URI(s) sharing it.
 * Returns [] when the string is not a known label — the caller then treats the
 * input as a raw URI (back-compat for callers that pass the URI directly).
 */
export function urisForPlacetypeLabel(label: string): string[] {
  return LABEL_TO_URIS.get(label.toLowerCase()) ?? [];
}
