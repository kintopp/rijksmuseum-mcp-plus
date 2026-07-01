/** AAT qualifier URIs that carry visual-similarity signal, with strength weights. */
export const LINEAGE_QUALIFIERS: ReadonlyMap<string, number> = new Map([
  ["http://vocab.getty.edu/aat/300404286", 3.0],  // after
  ["http://vocab.getty.edu/aat/300404287", 3.0],  // copyist of
  ["http://vocab.getty.edu/aat/300404274", 2.0],  // workshop of
  ["http://vocab.getty.edu/aat/300404269", 1.5],  // attributed to
  ["http://vocab.getty.edu/aat/300404283", 1.0],  // circle of (kring van)
  ["http://vocab.getty.edu/aat/300404284", 1.0],  // circle of (omgeving van) / school of
  ["http://vocab.getty.edu/aat/300404282", 1.0],  // follower of
]);

/** find_similar Related Variant labels (#293) — curator-declared peer edges where the
 *  creator is invariant. Shared by VocabularyDb's related_objects /
 *  physicalRelations paths and the SimilarityQueries Related Variant channel. */
export const RELATED_VARIANT_LABELS = [
  "different example", "production stadia", "pendant",
] as const;

/** Format earliest/latest date integers into a display string (e.g. "1642" or "1640–1650"). */
export function formatDateRange(earliest: number | null | undefined, latest: number | null | undefined): string | undefined {
  if (earliest == null) return undefined;
  return earliest === latest ? String(earliest) : `${earliest}–${latest}`;
}

/** Format height/width in cm as a dimension statement (e.g. "h 379.5 cm × w 453.5 cm"). */
export function formatDimensions(heightCm: number | null | undefined, widthCm: number | null | undefined): string | null {
  const parts: string[] = [];
  if (heightCm != null) parts.push(`h ${heightCm} cm`);
  if (widthCm != null) parts.push(`w ${widthCm} cm`);
  return parts.length > 0 ? parts.join(" × ") : null;
}
