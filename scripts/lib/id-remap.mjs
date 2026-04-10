/**
 * Shared helper for --id-remap mode in provenance writeback scripts.
 *
 * When running writebacks against a DB where artwork_id values have changed
 * (e.g. after a re-harvest), audit JSONs reference stale artwork_ids.
 * This module resolves object_number → current art_id via the artworks table.
 *
 * Usage in writeback scripts:
 *
 *   import { parseIdRemapFlag, createIdResolver } from "./lib/id-remap.mjs";
 *
 *   const idRemap = parseIdRemapFlag(args);
 *   const resolve = createIdResolver(db, idRemap);
 *
 *   // In the processing loop:
 *   const artworkId = resolve(result.data.artwork_id, result.data.object_number);
 *   if (artworkId == null) continue; // object_number not found in DB
 */

/**
 * Check whether --id-remap is present in CLI args.
 * @param {string[]} args - process.argv.slice(2)
 * @returns {boolean}
 */
export function parseIdRemapFlag(args) {
  return args.includes("--id-remap");
}

/**
 * Create a resolver function that returns the correct artwork_id.
 *
 * Without --id-remap: returns the original artwork_id from the audit JSON.
 * With --id-remap: resolves object_number → art_id via the DB, warns on miss.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {boolean} idRemap
 * @returns {(auditArtworkId: number, objectNumber: string|undefined) => number|null}
 */
export function createIdResolver(db, idRemap) {
  if (!idRemap) {
    return (auditArtworkId, _objectNumber) => auditArtworkId;
  }

  const stmt = db.prepare("SELECT art_id FROM artworks WHERE object_number = ?");
  const cache = new Map();

  return (_auditArtworkId, objectNumber) => {
    if (!objectNumber) {
      console.warn("  WARN: --id-remap set but object_number is missing from audit entry — skipping");
      return null;
    }
    if (cache.has(objectNumber)) return cache.get(objectNumber);

    const row = stmt.get(objectNumber);
    if (!row) {
      console.warn(`  WARN: object_number "${objectNumber}" not found in DB — skipping`);
      cache.set(objectNumber, null);
      return null;
    }
    cache.set(objectNumber, row.art_id);
    return row.art_id;
  };
}
