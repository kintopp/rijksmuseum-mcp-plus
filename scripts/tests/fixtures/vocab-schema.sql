-- Captured vocabulary-DB schema for hermetic VocabularyDb fixture tests (plans/003).
-- Source: data/vocabulary.db — regenerate after every harvest and diff for drift:
--   node scripts/tests/build-fixture-vocab-db.mjs --capture
-- version_info at capture:
--   enrichment_sources = 2019-edm-actors+2019-skos-thesaurus+2025-person-dump+2025-place-dump
--   built_at = 2026-05-02 06:37:03
--   artwork_count = 834435
--   vocab_count = 417564
--   mapping_count = 14799628
--   provenance_parsed_at = 2026-04-30T16:43:54.373Z
--   transfer_category_rule_at = 2026-04-30T16:44:05.700Z
--   party_disambiguation_at = 2026-04-30T16:44:13.745Z
--   party_disambiguation_batch = msgbatch_01YB9gWyEiwbPAFEKfbXTRUK
--   party_disambiguation_count = 154
--   residual_null_cleanup_at = 2026-04-30T16:44:13.836Z
--   unsold_price_extraction_at = 2026-04-30T16:44:22.725Z
--   unsold_price_extraction_count = 598
--   receiver_extraction_at = 2026-04-30T16:44:22.954Z
--   receiver_extraction_count = 995
--   event_reclass_at = 2026-04-30T16:47:35.288Z
--   event_reclass_batch = msgbatch_01BZY6NsEmHL5wTWz3CrrRvw
--   event_reclass_count = 66
--   event_splitting_at = 2026-04-30T16:47:35.484Z
--   event_splitting_batch = msgbatch_013ZjjPDeQLot9nUrSVCBDCc
--   event_splitting_count = 95
--   field_correction_at = 2026-04-30T17:20:41.823Z
--   field_correction_batch = msgbatch_01Ku3uNhy5sg3t4d5DUr8CUo
--   field_correction_count = 373
--   position_enrichment_at = 2026-04-30T18:11:51.152Z
--   position_enrichment_batch = msgbatch_01ApQm2wUMwmCWtuiNpnNV3G
--   llm_enrichment_at = 2026-04-30T18:13:04.444Z
--   llm_enrichment_batch = msgbatch_01GVXgHQH3HPF1hiRtVv7nh2
--   llm_enrichment_count = 0
--   enriched_at = 2026-05-02 06:37:03
--   enrichment = actors+places+thesaurus
--   entity_alt_names_provenance_at = 2026-05-02T11:18:27Z
--   entity_alt_names_human_reviewed_at = 2026-05-02T11:18:27Z
--   entity_alt_names_human_reviewed_count = 1087
--   entity_alt_names_human_inserted_count = 513
--   entity_alt_names_review_csv = data/audit/accepted-altname-candidates.csv
--   release_status = v0.40
--   v025_geo_backfill_at = 2026-05-02T13:16:45Z
--   v025_geo_backfill_source = data/vocabulary-v0.25-snapshot.db.gz
--   v025_geo_backfill_rows_touched = 27094
--   v025_geo_backfill_residual_gap = 7961
--   v025_geo_backfill_columns = lat,lon,placetype,placetype_source,is_areal,coord_method,coord_method_detail
--   v025_geo_backfill_provenance_tag = v0.25-snapshot-backfill
--   v025_geo_backfill_lat_after = 28016
--   v025_geo_backfill_placetype_after = 22468
--   v025_geo_backfill_is_areal_after = 22014
--   phase_2e_a_run_at = 2026-05-05 17:47:53
--   phase_2e_a_rows_updated = 52313
--   getty_outage_partial_run_at = 2026-05-06T17:14:30Z
--   getty_outage_partial_run_count = 361
--   getty_outage_partial_run_breakdown = wikidata_p625=297;geonames_api=25;tgn_via_wikidata_p1667=39;backfill_retro=257
--   getty_outage_partial_run_skipped = tgn_direct (vocab.getty.edu unreachable)
--   getty_outage_partial_run_log_dir = data/2026-05-06-getty-outage-partial
--   getty_outage_detail_repair_at = 2026-05-06T18:00:00Z
--   getty_outage_detail_repair_count = 191
--   getty_outage_detail_repair_note = Repaired NULL coord_method_detail on rows that batch_geocode.py wrote pre-fix; classified by vocabulary_external_ids.authority. 31 pre-existing rows with no authority record left unrepaired.
--   recovery_316_alias_merge_at = 2026-05-06T18:47:24Z
--   recovery_316_alias_merge_count = 185
--   production_role_pairs_built_at = 2026-06-06T11:52:58Z
--   production_role_pairs_vocab_built_at = 2026-05-02 06:37:03
-- captured: 2026-06-13T10:46:00.849Z
-- statements: 77 (tables + indexes; FTS shadow tables excluded)

CREATE TABLE artwork_exhibitions (
                art_id        INTEGER NOT NULL,
                exhibition_id INTEGER NOT NULL,
                PRIMARY KEY (art_id, exhibition_id)
            ) WITHOUT ROWID
        ;

CREATE TABLE artwork_external_ids (
    art_id     INTEGER NOT NULL,
    authority  TEXT NOT NULL,
    id         TEXT NOT NULL,
    uri        TEXT NOT NULL,
    PRIMARY KEY (art_id, authority, id)
) WITHOUT ROWID;

CREATE TABLE artwork_hmo_ids (
            art_id INTEGER PRIMARY KEY,
            hmo_id TEXT NOT NULL
        );

CREATE TABLE artwork_parent (
    art_id        INTEGER NOT NULL,
    parent_la_uri TEXT NOT NULL,
    parent_art_id INTEGER,
    PRIMARY KEY (art_id, parent_la_uri)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE artwork_texts_fts USING fts5(
                inscription_text, provenance_text, credit_line, description_text, narrative_text,
                title_all_text,
                content='artworks', content_rowid='rowid',
                tokenize='unicode61 remove_diacritics 2'
            );

CREATE TABLE artworks (
    object_number    TEXT PRIMARY KEY,
    title            TEXT,
    creator_label    TEXT,
    inscription_text TEXT,
    provenance_text  TEXT,
    credit_line      TEXT,
    description_text TEXT,
    height_cm        REAL,
    width_cm         REAL,
    narrative_text   TEXT,
    date_earliest    INTEGER,
    date_latest      INTEGER,
    title_all_text   TEXT,
    has_image        INTEGER DEFAULT 0,
    iiif_id          TEXT,
    date_display     TEXT,
    current_location TEXT,
    depth_cm         REAL,
    weight_g         REAL,
    diameter_cm      REAL,
    dimension_note   TEXT,
    provenance_text_hash TEXT,
    -- LDES record-edit timestamps (ISO 8601, nullable). Aggregated across
    -- referred_to_by[].created_by.timespan in the LA shape.
    record_created   TEXT,
    record_modified  TEXT,
    -- Free-text dimensions/extent string from dcterms:extent (CHO).
    extent_text      TEXT,
    -- HMO -> VisualItem cross-link from shows[0].id.
    art_id INTEGER, rights_id INTEGER, importance INTEGER DEFAULT 0);

CREATE TABLE assignment_pairs (
    artwork_id   INTEGER NOT NULL,
    qualifier_id TEXT NOT NULL,
    creator_id   TEXT NOT NULL,
    part_index   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (artwork_id, qualifier_id, creator_id)
) WITHOUT ROWID;

CREATE TABLE attribution_evidence (
    art_id              INTEGER NOT NULL,
    part_index          INTEGER NOT NULL,
    evidence_type_aat   TEXT,
    carried_by_uri      TEXT,
    label_text          TEXT,
    PRIMARY KEY (art_id, part_index, evidence_type_aat, carried_by_uri)
) WITHOUT ROWID;

CREATE TABLE backfill_role_pairs_progress (
    art_id       INTEGER PRIMARY KEY,
    processed_at INTEGER NOT NULL,
    status       TEXT NOT NULL
);

CREATE TABLE entity_alt_names (
    entity_id      TEXT NOT NULL,
    entity_type    TEXT NOT NULL,
    name           TEXT NOT NULL,
    lang           TEXT,
    classification TEXT, source TEXT, source_version TEXT, reviewed_by TEXT, reviewed_at TEXT, added_at TEXT, tier TEXT NOT NULL DEFAULT 'deterministic'
  CHECK (tier IN ('deterministic','inferred','manual')),
    UNIQUE(entity_id, name)
);

CREATE VIRTUAL TABLE entity_alt_names_fts
USING fts5(name, content='entity_alt_names', content_rowid='rowid');

CREATE TABLE examinations (
    art_id          INTEGER NOT NULL,
    seq             INTEGER NOT NULL,
    examiner_name   TEXT,
    report_type_id  TEXT NOT NULL,
    report_type_en  TEXT,
    date_display    TEXT,
    date_begin      TEXT,
    date_end        TEXT,
    PRIMARY KEY (art_id, seq)
) WITHOUT ROWID;

CREATE TABLE exhibition_members (
    exhibition_id INTEGER NOT NULL,
    hmo_id        TEXT NOT NULL,
    PRIMARY KEY (exhibition_id, hmo_id)
);

CREATE TABLE exhibitions (
    exhibition_id INTEGER PRIMARY KEY,
    title_en      TEXT,
    title_nl      TEXT,
    date_start    TEXT,
    date_end      TEXT
);

CREATE TABLE field_lookup (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);

CREATE TABLE "mappings" (
            artwork_id  INTEGER NOT NULL,
            vocab_rowid INTEGER NOT NULL,
            field_id    INTEGER NOT NULL,
            PRIMARY KEY (artwork_id, vocab_rowid, field_id)
        ) WITHOUT ROWID
    ;

CREATE TABLE modifications (
    art_id       INTEGER NOT NULL,
    seq          INTEGER NOT NULL,
    modifier_uri TEXT,
    date_display TEXT,
    date_begin   TEXT,
    date_end     TEXT,
    description  TEXT,
    PRIMARY KEY (art_id, seq)
) WITHOUT ROWID;

CREATE TABLE museum_rooms (
            room_hash  TEXT PRIMARY KEY,
            room_id    TEXT NOT NULL,
            floor      TEXT,
            room_name  TEXT
        );

CREATE TABLE person_names (
    person_id       TEXT NOT NULL REFERENCES vocabulary(id),
    name            TEXT NOT NULL,
    lang            TEXT,
    classification  TEXT,
    UNIQUE(person_id, name, lang)
);

CREATE VIRTUAL TABLE person_names_fts USING fts5(
                name,
                content='person_names', content_rowid='rowid',
                tokenize='unicode61 remove_diacritics 2'
            );

CREATE TABLE phase2_failures (
    uri        TEXT PRIMARY KEY,
    reason     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE phase_failures (
    phase         INTEGER NOT NULL,  -- 2, 4 (Phase 2b folds into 2)
    uri_or_objnum TEXT NOT NULL,
    failure_type  TEXT NOT NULL,     -- 'timeout', 'http_404', 'http_5xx', 'parse_error', 'unsupported_type:*', 'unknown'
    error_message TEXT,
    attempted_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    retry_count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (phase, uri_or_objnum)
) WITHOUT ROWID;

CREATE TABLE production_role_pairs (
    artwork_id   INTEGER NOT NULL,
    creator_id   TEXT NOT NULL,
    role_id      TEXT NOT NULL,
    part_index   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (artwork_id, creator_id, role_id)
) WITHOUT ROWID;

CREATE TABLE provenance_events (
  artwork_id     INTEGER NOT NULL,
  sequence       INTEGER NOT NULL,
  raw_text       TEXT    NOT NULL,
  gap            INTEGER NOT NULL DEFAULT 0,
  transfer_type  TEXT    NOT NULL,
  unsold         INTEGER NOT NULL DEFAULT 0,
  batch_price    INTEGER NOT NULL DEFAULT 0,
  transfer_category TEXT,
  category_method TEXT,
  uncertain      INTEGER NOT NULL DEFAULT 0,
  parties        TEXT,
  date_expression TEXT,
  date_year      INTEGER,
  date_qualifier TEXT,
  location       TEXT,
  price_amount   REAL,
  price_currency TEXT,
  sale_details   TEXT,
  citations      TEXT,
  is_cross_ref     INTEGER NOT NULL DEFAULT 0,
  cross_ref_target TEXT,
  parse_method   TEXT NOT NULL DEFAULT 'peg',
  correction_method TEXT,
  enrichment_reasoning TEXT,
  PRIMARY KEY (artwork_id, sequence)
) WITHOUT ROWID;

CREATE TABLE provenance_parties (
  artwork_id   INTEGER NOT NULL,
  sequence     INTEGER NOT NULL,
  party_idx    INTEGER NOT NULL,
  party_name   TEXT    NOT NULL,
  party_dates  TEXT,
  party_role   TEXT,
  party_position TEXT,
  position_method TEXT,
  uncertain    INTEGER NOT NULL DEFAULT 0,
  enrichment_reasoning TEXT,
  PRIMARY KEY (artwork_id, sequence, party_idx)
) WITHOUT ROWID;

CREATE TABLE provenance_periods (
  artwork_id          INTEGER NOT NULL,
  sequence            INTEGER NOT NULL,
  owner_name          TEXT,
  owner_dates         TEXT,
  location            TEXT,
  acquisition_method  TEXT,
  acquisition_from    TEXT,
  begin_year          INTEGER,
  begin_year_latest   INTEGER,
  end_year            INTEGER,
  derivation          TEXT,
  uncertain           INTEGER NOT NULL DEFAULT 0,
  citations           TEXT,
  source_events       TEXT,
  PRIMARY KEY (artwork_id, sequence)
) WITHOUT ROWID;

CREATE TABLE related_objects (
    art_id           INTEGER NOT NULL,
    related_la_uri   TEXT NOT NULL,
    related_art_id   INTEGER,
    relationship_en  TEXT NOT NULL,
    relationship_nl  TEXT,
    PRIMARY KEY (art_id, related_la_uri)
) WITHOUT ROWID;

CREATE TABLE rights_lookup (id INTEGER PRIMARY KEY, uri TEXT NOT NULL UNIQUE);

CREATE TABLE sync_state (
            key   TEXT PRIMARY KEY,
            value TEXT
        );

CREATE TABLE title_variants (
    art_id     INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    title_text TEXT NOT NULL,
    language   TEXT,
    qualifier  TEXT,
    PRIMARY KEY (art_id, seq)
) WITHOUT ROWID;

CREATE TABLE version_info (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE vocab_term_counts(vocab_id TEXT,cnt);

CREATE TABLE vocabulary (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    label_en    TEXT,
    label_nl    TEXT,
    external_id TEXT,
    broader_id  TEXT,
    notation    TEXT,
    lat             REAL,
    lon             REAL,
    label_en_norm   TEXT,
    label_nl_norm   TEXT
, geocode_method TEXT, coord_method TEXT, external_id_method TEXT, broader_method TEXT, coord_method_detail TEXT, external_id_method_detail TEXT, broader_method_detail TEXT, placetype TEXT, placetype_source TEXT, is_areal INTEGER, birth_year INTEGER, death_year INTEGER, gender TEXT, bio TEXT, wikidata_id TEXT, vocab_int_id INTEGER);

CREATE TABLE vocabulary_external_ids (
    vocab_id    TEXT NOT NULL,
    authority   TEXT NOT NULL,
    id          TEXT NOT NULL,
    uri         TEXT NOT NULL,
    PRIMARY KEY (vocab_id, authority, id)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE vocabulary_fts USING fts5(
            label_en, label_nl,
            content='vocabulary', content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
        );

CREATE INDEX idx_artwork_external_ids_authority ON artwork_external_ids(authority, id);

CREATE INDEX idx_artwork_parent_reverse ON artwork_parent(parent_art_id);

CREATE UNIQUE INDEX idx_artworks_art_id ON artworks(art_id);

CREATE INDEX idx_artworks_date_range ON artworks(date_earliest, date_latest) WHERE date_earliest IS NOT NULL;

CREATE INDEX idx_artworks_height ON artworks(height_cm) WHERE height_cm IS NOT NULL;

CREATE INDEX idx_artworks_importance ON artworks(importance DESC);

CREATE INDEX idx_artworks_record_modified ON artworks(record_modified) WHERE record_modified IS NOT NULL;

CREATE INDEX idx_artworks_width ON artworks(width_cm) WHERE width_cm IS NOT NULL;

CREATE INDEX idx_assignment_pairs_qualifier
  ON assignment_pairs(qualifier_id, creator_id, artwork_id);

CREATE INDEX idx_attribution_evidence_art ON attribution_evidence(art_id);

CREATE INDEX idx_entity_alt_names_type ON entity_alt_names(entity_type);

CREATE INDEX idx_mappings_field_vocab ON mappings(field_id, vocab_rowid);

CREATE INDEX idx_party_name ON provenance_parties(party_name);

CREATE INDEX idx_party_position ON provenance_parties(party_position) WHERE party_position IS NOT NULL;

CREATE INDEX idx_party_position_method ON provenance_parties(position_method) WHERE position_method IS NOT NULL;

CREATE INDEX idx_period_begin ON provenance_periods(begin_year) WHERE begin_year IS NOT NULL;

CREATE INDEX idx_period_end ON provenance_periods(end_year) WHERE end_year IS NOT NULL;

CREATE INDEX idx_period_method ON provenance_periods(acquisition_method);

CREATE INDEX idx_period_owner ON provenance_periods(owner_name) WHERE owner_name IS NOT NULL;

CREATE INDEX idx_person_names_id ON person_names(person_id);

CREATE INDEX idx_phase2_failures_reason ON phase2_failures(reason);

CREATE INDEX idx_phase_failures_type ON phase_failures(failure_type);

CREATE INDEX idx_production_role_pairs_role
  ON production_role_pairs(role_id, creator_id, artwork_id);

CREATE INDEX idx_prov_category ON provenance_events(transfer_category) WHERE transfer_category IS NOT NULL;

CREATE INDEX idx_prov_category_method ON provenance_events(category_method) WHERE category_method IS NOT NULL;

CREATE INDEX idx_prov_location ON provenance_events(location) WHERE location IS NOT NULL;

CREATE INDEX idx_prov_transfer ON provenance_events(transfer_type);

CREATE INDEX idx_prov_unsold ON provenance_events(unsold) WHERE unsold = 1;

CREATE INDEX idx_prov_year ON provenance_events(date_year) WHERE date_year IS NOT NULL;

CREATE INDEX idx_vei_authority_id ON vocabulary_external_ids (authority, id);

CREATE INDEX idx_vei_uri          ON vocabulary_external_ids (uri);

CREATE INDEX idx_vocab_birth_year ON vocabulary(birth_year) WHERE birth_year IS NOT NULL;

CREATE INDEX idx_vocab_broader_id ON vocabulary(broader_id) WHERE broader_id IS NOT NULL;

CREATE INDEX idx_vocab_gender ON vocabulary(gender) WHERE gender IS NOT NULL;

CREATE UNIQUE INDEX idx_vocab_int_id ON vocabulary(vocab_int_id);

CREATE INDEX idx_vocab_label_en ON vocabulary(label_en COLLATE NOCASE);

CREATE INDEX idx_vocab_label_nl ON vocabulary(label_nl COLLATE NOCASE);

CREATE INDEX idx_vocab_lat_lon ON vocabulary(lat, lon) WHERE lat IS NOT NULL;

CREATE INDEX idx_vocab_notation ON vocabulary(notation);

CREATE INDEX idx_vocab_type ON vocabulary(type);

CREATE INDEX idx_vocab_wikidata ON vocabulary(wikidata_id) WHERE wikidata_id IS NOT NULL;

CREATE INDEX idx_vtc_cnt ON vocab_term_counts(cnt DESC);
