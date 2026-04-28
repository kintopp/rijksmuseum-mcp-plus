-- v0.25 cold-rerun reset (per #218 cold-rerun migration design).
-- Clears coords + external_ids + provenance columns for non-Rijksmuseum-sourced
-- place rows. Rijksmuseum-sourced rows (external_id LIKE 'http%rijksmuseum%')
-- are preserved as-is — those came from the LOD harvest, not gazetteer phases.
--
-- The trust-tier guard in geocode_places.update_coords / update_coords_and_ids
-- (`AND lat IS NULL`) means downstream phases will only write to rows we
-- cleared here.

BEGIN;

UPDATE vocabulary
   SET lat                       = NULL,
       lon                       = NULL,
       external_id               = NULL,
       coord_method              = NULL,
       coord_method_detail       = NULL,
       external_id_method        = NULL,
       external_id_method_detail = NULL,
       broader_method            = NULL,
       broader_method_detail     = NULL
 WHERE type = 'place'
   AND (external_id IS NULL OR external_id NOT LIKE 'http%rijksmuseum%');

COMMIT;

-- Sanity counts post-clear (printed by sqlite3, not part of the txn)
SELECT 'places_total'      AS k, COUNT(*) AS n FROM vocabulary WHERE type='place'
UNION ALL
SELECT 'with_coords'       AS k, COUNT(*) AS n FROM vocabulary WHERE type='place' AND lat IS NOT NULL
UNION ALL
SELECT 'with_external_id'  AS k, COUNT(*) AS n FROM vocabulary WHERE type='place' AND external_id IS NOT NULL
UNION ALL
SELECT 'with_coord_method' AS k, COUNT(*) AS n FROM vocabulary WHERE type='place' AND coord_method IS NOT NULL;
