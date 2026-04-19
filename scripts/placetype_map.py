"""AAT / Wikidata placetype → is_areal mapping for #254.

Used by scripts/harvest-placetypes.py to convert Getty TGN
``gvp:placeTypePreferred`` values (AAT URIs) and Wikidata ``P31`` values
(QIDs) into the single runtime signal ``vocabulary.is_areal``:

  - True  → "centroid not meaningful for point-based queries"
            (continents, oceans, seas, historical empires, admin
            polygons that are too wide for a useful centroid, rivers
            whose conventional point is a mouth, mountain ranges).
  - False → a meaningful point (inhabited places, buildings, estates,
            named venues, specific geographic features).
  - None  → we don't know (not in the map). Caller should leave
            ``is_areal`` NULL rather than guessing.

**Append-only contract:** once a code is in the map, don't change its
value — downstream readers persist the derived ``is_areal`` and would
go out of sync. To flip a classification, add a new code or let the
manual-override TSV (scripts/areal_overrides.tsv) take precedence.

**Country edge case:** modern countries (AAT 300128207 "countries,
nations"; Wikidata Q6256 "country") are classified as ``True`` in this
map. For artwork attribution, "produced in France" is more usefully
represented by the specific city than by France's admin centroid at
(46, 2). Callers that want country-tier points can still read
``vocabulary.lat``/``lon`` directly — the ``is_areal`` flag only
governs whether point-based runtime filters include the row.
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# Getty TGN — AAT placetype URIs
# ---------------------------------------------------------------------------
# Key: bare AAT numeric code (e.g. "300008376"). Full URI form
# "http://vocab.getty.edu/aat/300008376" is normalised off at lookup time.

AAT_IS_AREAL: dict[str, bool] = {
    # ── Areal: centroids geometrically meaningless for attribution ─────────
    "300008376": True,   # continents
    "300008574": True,   # geographic regions (physiographic areas)
    "300387575": True,   # regions (sub-continent, cultural/admin)
    "300008791": True,   # nations (modern countries — see docstring edge case)
    "300128207": True,   # countries, nations (alternative label)
    "300008389": True,   # historical states / former states
    "300008400": True,   # empires
    "300000774": True,   # dependencies (colonial territories)
    "300387176": True,   # colonies
    "300387174": True,   # colonies (political entity subclass)
    "300387167": True,   # historical countries
    "300387068": True,   # kingdoms (historical polities)
    "300386862": True,   # duchies
    "300387069": True,   # provinces (top-level admin; polygon)
    "300387126": True,   # departments (France etc., top-level admin)
    "300000776": True,   # first-level admin divisions (generic)
    "300387506": True,   # constituent countries (England, Scotland, Wales, N. Ireland)
    "300235093": True,   # archipelagos
    # Bodies of water — centroid is hydrographically meaningless.
    "300008804": True,   # bodies of water (aggregate)
    "300008707": True,   # oceans
    "300008794": True,   # seas
    "300008716": True,   # lakes
    "300008720": True,   # rivers (representative point, not a "location")
    "300132324": True,   # bays
    "300008831": True,   # straits
    "300386699": True,   # gulfs
    # Landforms whose extent is the point of interest.
    "300387657": True,   # mountain ranges
    "300008742": True,   # deserts
    "300008460": True,   # plains
    "300008464": True,   # plateaus
    "300008421": True,   # valleys (when representing the valley as region)
    "300386833": True,   # basins (drainage)

    # ── Point: a specific location is meaningful ───────────────────────────
    "300008569": False,  # inhabited places (cities, towns, villages)
    "300008347": False,  # settlements (broader settlement class)
    "300008375": False,  # cities (specific subclass)
    "300008381": False,  # towns
    "300008382": False,  # villages
    "300008398": False,  # capitals (cities)
    "300386853": False,  # neighborhoods
    "300006053": False,  # buildings (structures)
    "300005317": False,  # houses
    "300007466": False,  # churches (buildings)
    "300007474": False,  # cathedrals
    "300007475": False,  # chapels
    "300007000": False,  # castles (individual structures)
    "300007546": False,  # palaces
    "300005225": False,  # monasteries
    "300005211": False,  # abbeys
    "300005768": False,  # museums (single-site)
    "300006891": False,  # theaters (venues)
    "300007469": False,  # mosques
    "300007552": False,  # synagogues
    "300000809": False,  # estates (individual properties)
    # Individual landforms that ARE points (peaks, named summits, specific features).
    "300008436": False,  # mountains (individual peaks)
    "300008438": False,  # peaks
    "300132194": False,  # volcanoes (specific)
    "300008477": False,  # caves
    "300008475": False,  # waterfalls (specific)
    "300008470": False,  # springs (water)
    "300008408": False,  # islands (individual — Rijksmuseum convention is
                         # to use the island's point even though it's areal;
                         # large islands like Greenland are edge cases better
                         # handled by manual override)

    # ── Codes observed in practice on v0.24 DB (probed 2026-04-19) ─────────
    # Labels fetched via gvp:prefLabelGVP/gvp:term. Listed separately so the
    # provenance of each mapping is traceable back to the probe run.
    "300128176": True,   # continents (landmasses — the variant TGN prefers)
    "300000771": True,   # counties (admin polygon)
    "300387346": True,   # general regions
    "300387081": True,   # national districts (top-level admin)
    "300235099": True,   # prefectures (Japan/China — large admin)
    "300387179": True,   # former administrative divisions (historical admin)
    "300265612": True,   # municipalities (can span huge areas, e.g. Shanghai)
    "300387107": True,   # autonomous regions (Guangxi etc.)
    "300235107": True,   # oblasts (Russian admin regions)
    "300387356": True,   # former primary political entities (historical countries)
    "300387213": True,   # special municipalities
    "300387178": True,   # historical regions
    "300387145": True,   # second level subdivisions (departments, counties)

    "300008850": False,  # capes (point-like landforms)
    "300387340": False,  # Ortsteile (small German neighborhoods)
    "300387336": False,  # rioni (Italian neighborhoods)
    "300387218": False,  # capitals (city-level)
    # 300000745 (no en label observed)
    # 300008734 (no en label; sample "Coromandelkust" suggests "coasts" → areal
    #           but not confirmed via SPARQL label, so left NULL)
    # 300387198 "third level subdivisions" — ambiguous (districts vs counties);
    #           leave NULL, rely on manual override for specific cases.
}


# ---------------------------------------------------------------------------
# Wikidata — P31 (instance of) QIDs
# ---------------------------------------------------------------------------
# Chosen to mirror the AAT decisions above. Kept separate because Wikidata's
# class hierarchy doesn't line up 1:1 with AAT's; some QIDs have no AAT
# analogue (e.g. Q3024240 "historical country" as a class) and vice versa.

WD_IS_AREAL: dict[str, bool] = {
    # ── Areal ────────────────────────────────────────────────────────────
    "Q5107":      True,  # continent
    "Q82794":     True,  # geographic region
    "Q3455524":   True,  # cultural region
    "Q6256":      True,  # country (modern — see docstring edge case)
    "Q3624078":   True,  # sovereign state
    "Q3024240":   True,  # historical country
    "Q1520223":   True,  # historical region
    "Q1763527":   True,  # constituent country (UK constituents, etc.)
    "Q112099":    True,  # island nation
    "Q48":        True,  # Asia   (is its own instance of continent)
    "Q15":        True,  # Africa
    "Q46":        True,  # Europe
    "Q18":        True,  # South America
    "Q49":        True,  # North America
    "Q538":       True,  # Oceania
    # Oceans / seas / major water bodies.
    "Q165":       True,  # sea
    "Q9430":      True,  # ocean
    "Q23397":     True,  # lake
    "Q4022":      True,  # river
    "Q39594":     True,  # strait
    "Q22698":     True,  # park (large parks are areal; small ones manual)
    # Historical polities that often carry authority-tier centroids.
    "Q1196129":   True,  # protectorate
    "Q417175":    True,  # caliphate
    "Q417258":    True,  # khanate
    "Q3299107":   True,  # autonomous administrative division
    "Q11828004":  True,  # province of Italy
    "Q107390":    True,  # federated state (US states, German Länder)
    "Q34876":     True,  # province (generic)
    "Q484170":    True,  # commune of France (top-level admin at commune level
                         # can be wide — edge case; err on the side of areal)
    # Landforms whose extent > usable centroid.
    "Q46831":     True,  # mountain range
    "Q8514":      True,  # desert
    "Q162908":    True,  # archipelago
    "Q47521":     True,  # stream (linear feature)
    "Q1172599":   True,  # drainage basin

    # ── Point ───────────────────────────────────────────────────────────
    "Q515":       False,  # city
    "Q3957":      False,  # town
    "Q532":       False,  # village
    "Q486972":    False,  # human settlement (generic)
    "Q5119":      False,  # capital city
    "Q1549591":   False,  # big city
    "Q123705":    False,  # neighborhood
    "Q2983893":   False,  # hamlet
    "Q15284":     False,  # municipality (when small — edge case)
    "Q41176":     False,  # building
    "Q16970":     False,  # church building
    "Q23413":     False,  # castle (specific)
    "Q751876":    False,  # château
    "Q16560":     False,  # palace
    "Q15221":     False,  # abbey
    "Q1802963":   False,  # parish church
    "Q33506":     False,  # museum
    "Q35127":     False,  # cinema (edge case — excluded from geocoding elsewhere)
    "Q24354":     False,  # theater building
    "Q4989906":   False,  # monument
    "Q210272":    False,  # cultural heritage (monument)
    "Q57821":     False,  # fortification (specific)
    "Q12280":     False,  # bridge
    "Q44782":     False,  # port
    "Q55488":     False,  # railway station
    "Q8502":      False,  # mountain (individual — conventionally peak point)
    "Q34763":     False,  # peninsula
    "Q23442":     False,  # island (individual; see AAT note about edge cases)
    "Q23444":     False,  # promontory (point-like)
    "Q1076486":   False,  # sports venue
    "Q839954":    False,  # street
    "Q34442":     False,  # road
    "Q4294693":   False,  # square/plaza
}


def normalise_aat(value: str) -> str:
    """Strip 'http://vocab.getty.edu/aat/' prefix if present, return bare code."""
    for prefix in (
        "http://vocab.getty.edu/aat/",
        "https://vocab.getty.edu/aat/",
    ):
        if value.startswith(prefix):
            return value[len(prefix):]
    return value


def normalise_qid(value: str) -> str:
    """Strip 'http://www.wikidata.org/entity/' prefix if present."""
    for prefix in (
        "http://www.wikidata.org/entity/",
        "https://www.wikidata.org/entity/",
    ):
        if value.startswith(prefix):
            return value[len(prefix):]
    return value


def classify_aat(aat_value: str) -> bool | None:
    """Return ``True``/``False`` per AAT_IS_AREAL, or ``None`` if unmapped."""
    return AAT_IS_AREAL.get(normalise_aat(aat_value))


def classify_qid(qid_value: str) -> bool | None:
    """Return ``True``/``False`` per WD_IS_AREAL, or ``None`` if unmapped."""
    return WD_IS_AREAL.get(normalise_qid(qid_value))
