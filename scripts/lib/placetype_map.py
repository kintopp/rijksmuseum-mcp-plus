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
manual-override TSV (scripts/geocoding/areal_overrides.tsv) take precedence.

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
    # 300387198 third level subdivisions — superseded by v0.25 additions below.

    # ── v0.25 additions (probed 2026-04-26 via Getty SPARQL skos:prefLabel) ─
    # All distinct AAT codes from data/audit/areal-classifier-extension/
    # tgn-gap.tsv (129 codes, 1209 rows). Rubric: container/extent → True,
    # specific feature → False.
    #
    # See data/audit/areal-classifier-extension/summary.md for the audit
    # log; entries are grouped (water bodies, landforms, admin, point).
    "300008687": True,   # oceans (marine bodies of water) - Atlantic, Indian etc.
    "300008680": True,   # lakes (bodies of water)
    "300008694": True,   # seas (alt code; cf. 300008794)
    "300008676": True,   # fiords (linear inlets)
    "300008679": True,   # lagoons (bodies of water)
    "300008699": True,   # streams (linear)
    "300008713": True,   # channels (water bodies - English Channel etc.)
    "300008734": True,   # coastline (land/sea border)
    "300006075": True,   # canals (waterways - linear)
    "300132315": True,   # gulfs (bodies of water)
    "300132316": True,   # bays (bodies of water)
    "300266556": True,   # salt lakes
    "300266558": True,   # sounds (bodies of water)
    "300266559": True,   # straits (alt code; cf. 300008831)
    "300266571": True,   # estuaries
    "300387026": True,   # marine channels
    "300387055": True,   # distributaries (streams)
    "300379998": True,   # wadis (dry riverbeds - linear)
    "300387097": True,   # submerged features
    "300008761": True,   # valleys (landforms; cf. 300008421)
    "300008777": True,   # hills (landforms - areal extent)
    "300008805": True,   # plains (landforms; cf. 300008460)
    "300008863": True,   # forests (cultural landscapes)
    "300008916": True,   # deserts (alt to 300008742)
    "300132339": True,   # plateaus
    "300132348": True,   # surf ridges / brandingsruggen (linear coastal)
    "300132451": True,   # woods (plant communities - cultural landscapes)
    "300386831": True,   # mountain ranges (alt code; cf. 300387657)
    "300386832": True,   # mountain systems
    "300386846": True,   # points (landforms - coastal points/headlands extent)
    "300386854": True,   # archipelagos (alt to 300235093)
    "300386856": True,   # uplands
    "300386886": True,   # moors (landforms)
    "300386887": True,   # heaths (landforms)
    "300387036": True,   # shoals (landforms)
    "300387499": True,   # headlands (treat as areal feature)
    "300008835": True,   # glaciers - large alpine glacier extents
    "300132325": True,   # volcanoes - class-level often refers to whole massif
    "300000745": True,   # neighborhoods (NL buurten - generic neighborhood class)
    "300000769": True,   # cantons (administrative bodies - Swiss cantons etc.)
    "300000772": True,   # departments (political divisions - top-level FR admin)
    "300000778": True,   # boroughs (NL deelgemeenten - large admin)
    "300132618": True,   # metropolitan areas
    "300179493": True,   # republics (federated/autonomous republics)
    "300182722": True,   # regions (geographic) - generic geographic region
    "300182723": True,   # subcontinents
    "300232418": True,   # divisions (political administrative bodies)
    "300235104": True,   # emirates (state-tier admin)
    "300235112": True,   # voivodeships (PL top-level admin)
    "300236112": True,   # regions (administrative divisions - IT regioni etc.)
    "300387052": True,   # semi-independent political entities (Hong Kong etc.)
    "300387064": True,   # first level subdivisions (political entities)
    "300387067": True,   # special cities - admin extent (Busan etc.)
    "300387071": True,   # unitary authorities (UK admin polygon)
    "300387072": True,   # local councils (subdivisions - NIR admin)
    "300387080": True,   # autonomous districts
    "300387082": True,   # national divisions
    "300387109": True,   # autonomous provinces
    "300387110": True,   # autonomous republics (Abkhazia etc.)
    "300387113": True,   # autonomous communities (ES Comunidades Autonomas)
    "300387122": True,   # union territories (IN top-level admin)
    "300387130": True,   # autonomous areas
    "300387131": True,   # regional divisions
    "300387194": True,   # unions (political entities - Benelux)
    "300387198": True,   # third level subdivisions (political entities)
    "300387199": True,   # fourth level subdivisions (political entities)
    "300387205": True,   # localities (broad)
    "300387241": True,   # former communities (extinct admin)
    "300387244": True,   # lost areas
    "300387330": True,   # communes (administrative - large FR/IT/ES communes)
    "300387331": True,   # parts of inhabited places (large neighborhoods)
    "300387354": True,   # former groups of political entities (Dutch Republic)
    "300391481": True,   # comitaten (HU comitatus - top-level admin)
    "300391502": True,   # raions (E. European top-level admin)
    "300412029": True,   # former territories/colonies/dependencies
    "300006163": True,   # polders - Dutch reclaimed-land polygons
    "300170882": True,   # dikes - linear feature
    "300008178": True,   # nature reserves
    "300008189": True,   # national parks
    "300008192": True,   # state parks
    "300000206": False,   # farms - boerderijen (named farmsteads)
    "300000291": False,   # homesteads (single residences)
    "300000641": False,   # monasteries (built complexes - alt to 300005225)
    "300000810": False,   # archaeological sites (specific sites)
    "300000833": False,   # historic sites (specific sites)
    "300000835": False,   # battlefields
    "300000874": False,   # suburbs (specific named places - Murano)
    "300002916": False,   # gates (barriers - Zhengyang Men)
    "300004792": False,   # buildings (alt to 300006053)
    "300005567": False,   # country houses (Chateau Margaux etc.)
    "300005734": False,   # palaces (alt to 300007546)
    "300005993": False,   # government office buildings
    "300006191": False,   # reservoirs (water distribution structures - small named)
    "300006909": False,   # forts (alt to 300007000 castles)
    "300007423": False,   # cloisters
    "300007501": False,   # cathedrals (alt to 300007474)
    "300007595": False,   # temples (buildings - Borobudur etc.)
    "300007783": False,   # railroad stations
    "300007836": False,   # bridges (built works - Pont du Gard)
    "300008057": False,   # ruins (specific structure - point)
    "300008187": False,   # parks (public recreation areas - Battersea Park)
    "300008217": False,   # roads - Via Appia; conventional landmark point
    "300008220": False,   # highways - same convention
    "300008304": False,   # squares (open spaces - Piazza Navona)
    "300008537": False,   # lost settlements (specific abandoned villages)
    "300008678": False,   # havens / boat basins (named harbours)
    "300008688": False,   # ponds (water - small named ponds)
    "300008736": False,   # waterfalls (alt to 300008475)
    "300008767": False,   # gorges (landforms - narrow point-like)
    "300008795": False,   # mountains (landforms - alt to 300008436; specific peaks)
    "300008798": False,   # peaks (landforms - alt to 300008438)
    "300008853": False,   # promontories - alt to 300008850
    "300011692": False,   # rock (inorganic material - Indian Head etc.)
    "300120801": False,   # docks (waterfront spaces)
    "300132350": False,   # flats (landforms - small named flats)
    "300164841": False,   # piazzas (squares)
    "300167671": False,   # deserted settlements (specific named site)
    "300259572": False,   # passes (landforms - mountain passes)
    "300266640": False,   # ridges (landforms - specific named ridges)
    # 300386699: True (gulfs) — already in the original areal block above; not re-added.
    "300386958": False,   # former structures
    "300386960": False,   # historic structures
    "300386984": False,   # abandoned complexes
    "300386998": False,   # sacred sites (specific sites)
    "300387004": False,   # burial sites
    "300387007": False,   # ancient sites
    "300387200": False,   # locales (settlements)
    "300387270": False,   # transport hubs / verkeerscentra
    "300387502": False,   # estates (commercial agricultural - landgoederen)
    "300391533": False,   # tidal islands (small islands, conventional centroid)
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

    # ── v0.25 additions to WD (probed 2026-04-26 via Wikidata SPARQL) ─────
    # P31 class QIDs from data/audit/areal-classifier-extension/wikidata-
    # gap.tsv. Only classes (placetype_source = wikidata, P31 stored) are
    # listed; the gap TSV ranks them by row count. See summary.md for
    # coverage stats and intentionally-unmapped tail.
    #
    # Areal additions:
    "Q1002812":  True,   # metropolitan borough
    "Q1048163":  True,   # traditional geographic divisions of Greece
    "Q1050126":  True,   # sub-provincial district of the PRC
    "Q1059478":  True,   # town of Japan
    "Q1065118":  True,   # district of China
    "Q10711424":  True,   # state with limited recognition
    "Q10742":  True,   # autonomous community of Spain
    "Q107425":  True,   # landscape
    "Q1086783":  True,   # regular moon
    "Q1093829":  True,   # city in the United States
    "Q110010841":  True,   # hamlet of New York
    "Q1115575":  True,   # civil parish (England)
    "Q11183787":  True,   # Ortschaft
    "Q1131296":  True,   # freguesia of Portugal
    "Q1134686":  True,   # frazione (IT subdivision)
    "Q1138494":  True,   # historic county of England
    "Q1149061":  True,   # language area
    "Q1149652":  True,   # district of India
    "Q116280840":  True,   # waard (NL landscape type)
    "Q116457956":  True,   # municipality without town privileges in Germany
    "Q11687019":  True,   # external territory of Australia
    "Q11762356":  True,   # valley glacier
    "Q117871604":  True,   # former municipality of Greece
    "Q1187580":  True,   # non-metropolitan district
    "Q1187811":  True,   # college town
    "Q1210950":  True,   # channel (water body)
    "Q1221156":  True,   # federated state of Germany
    "Q12284":  True,   # canal (waterway)
    "Q122987726":  True,   # tehsil of Ladakh
    "Q1230110":  True,   # district of Sri Lanka
    "Q1234255":  True,   # regional unit of Greece
    "Q12443800":  True,   # state of India
    "Q12813115":  True,   # urban area in Sweden
    "Q1289426":  True,   # county of China
    "Q1317848":  True,   # county of Northern Ireland
    "Q13212489":  True,   # county of California
    "Q13217644":  True,   # municipality of Portugal
    "Q13218357":  True,   # city of California
    "Q13218690":  True,   # town in Hungary
    "Q1322134":  True,   # gulf
    "Q133056":  True,   # mountain pass
    "Q1330941":  True,   # Royal Parks of London
    "Q133156":  True,   # colony
    "Q1336152":  True,   # princely state
    "Q13414759":  True,   # county of Ohio
    "Q13415859":  True,   # District of Wuppertal
    "Q1344695":  True,   # province of Iran
    "Q1349648":  True,   # municipality of Greece
    "Q1351282":  True,   # crown colony
    "Q1364273":  True,   # national park of South Africa
    "Q137186904":  True,   # transcontinental region
    "Q137535":  True,   # county of Iran
    "Q137773":  True,   # ward of Japan
    "Q1402592":  True,   # island group
    "Q1414991":  True,   # area (country subdivision)
    "Q1430000":  True,   # 
    "Q1437459":  True,   # non-geologically related mountain range
    "Q146591":  True,   # circle of latitude
    "Q14757767":  True,   # fourth-level administrative division
    "Q150093":  True,   # voivodeship of Poland
    "Q1501897":  True,   # Generality Lands
    "Q15060255":  True,   # council area (Scotland)
    "Q15063611":  True,   # city in the state of New York
    "Q150784":  True,   # canyon
    "Q15079751":  True,   # borough of Amsterdam
    "Q15089":  True,   # province of Italy
    "Q15127012":  True,   # town in the United States
    "Q15149663":  True,   # state of Mexico
    "Q15239622":  True,   # disputed territory
    "Q15324":  True,   # body of water
    "Q1539014":  True,   # ressort of Suriname
    "Q154547":  True,   # duchy
    "Q15642541":  True,   # human-geographic territorial entity
    "Q15661340":  True,   # ancient city
    "Q160091":  True,   # plain
    "Q16110":  True,   # region of Italy
    "Q161243":  True,   # dependent territory
    "Q1615742":  True,   # province of China
    "Q1620908":  True,   # historical region
    "Q162620":  True,   # province of Spain
    "Q1639634":  True,   # local government area of Nigeria
    "Q166620":  True,   # drainage basin
    "Q170156":  True,   # confederation
    "Q17051044":  True,   # mahalle (TR subdivision)
    "Q1778846":  True,   # military training area
    "Q1782540":  True,   # railway town
    "Q1790360":  True,   # colonial empire
    "Q179049":  True,   # nature reserve
    "Q1797194":  True,   # arts district
    "Q1803855":  True,   # province group in the Netherlands
    "Q180673":  True,   # ceremonial county of England
    "Q181307":  True,   # lieu-dit
    "Q184188":  True,   # canton of France (former)
    "Q18524218":  True,   # canton of France
    "Q1857731":  True,   # historic county of Wales
    "Q188025":  True,   # salt lake
    "Q188509":  True,   # suburb
    "Q188604":  True,   # county of Hungary
    "Q192287":  True,   # administrative divisions of Russia
    "Q193512":  True,   # region of Finland
    "Q193556":  True,   # province of Sweden
    "Q1952852":  True,   # municipality of Mexico
    "Q196068":  True,   # lordship
    "Q1969642":  True,   # neighborhood in San Francisco
    "Q1970725":  True,   # natural region
    "Q19730508":  True,   # former municipality
    "Q1985797":  True,   # municipal unit of Greece
    "Q199403":  True,   # tropical forest (Amazon)
    "Q19953632":  True,   # former administrative territorial entity
    "Q20202352":  True,   # locality of Mexico
    "Q2039348":  True,   # municipality of the Netherlands
    "Q204324":  True,   # volcanic crater lake
    "Q204894":  True,   # marginal sea
    "Q2074737":  True,   # municipality of Spain
    "Q209495":  True,   # historical province of France
    "Q2140214":  True,   # parish of Jersey
    "Q2177636":  True,   # municipality of Denmark
    "Q22746":  True,   # urban park
    "Q2276925":  True,   # municipality of Galicia
    "Q22865":  True,   # independent city of Germany
    "Q23010647":  True,   # suburb of Perth
    "Q23036513":  True,   # former municipality of Denmark
    "Q23058":  True,   # canton of Switzerland
    "Q251749":  True,   # pueblo
    "Q252916":  True,   # administrative quarter of Paris
    "Q2578218":  True,   # inland sea
    "Q257978":  True,   # statutory city in the Czech Republic
    "Q2590631":  True,   # municipality of Hungary
    "Q261023":  True,   # district of Vienna
    "Q26211545":  True,   # desa (Indonesian admin)
    "Q26830017":  True,   # state in the Holy Roman Empire
    "Q26987258":  True,   # grand place (large public square)
    "Q272888":  True,   # red-light district
    "Q2740635":  True,   # Stadtbezirk
    "Q2755753":  True,   # area of London
    "Q27676416":  True,   # city or town of Quebec
    "Q2785216":  True,   # former municipality of Belgium (section)
    "Q28539166":  True,   # quarter of Basel
    "Q2919801":  True,   # municipality of Luxembourg
    "Q2989398":  True,   # commune of Algeria
    "Q3032116":  True,   # district of canton of Aargau
    "Q3032132":  True,   # district of canton of Vaud
    "Q3055118":  True,   # single entity of population (ES)
    "Q3148864":  True,   # imada (TN subdivision)
    "Q3184121":  True,   # municipality of Brazil
    "Q3191695":  True,   # regency of Indonesia
    "Q3199141":  True,   # city of Indonesia
    "Q3257686":  True,   # locality
    "Q33146843":  True,   # municipality of Catalonia
    "Q33837":  True,   # archipelago
    "Q34038":  True,   # waterfall (large)
    "Q3413329":  True,   # neighborhood in Boston
    "Q3434769":  True,   # macroregion
    "Q353344":  True,   # countship
    "Q3558970":  True,   # village of Poland
    "Q35657":  True,   # U.S. state
    "Q35666":  True,   # glacier (large extent)
    "Q36784":  True,   # region of France
    "Q3685476":  True,   # abolished municipality in Italy
    "Q3700011":  True,   # kecamatan
    "Q3757179":  True,   # parcan of Occitania
    "Q379158":  True,   # district of Norway
    "Q38911":  True,   # region of the Czech Republic
    "Q3920245":  True,   # Historical city of Russia
    "Q39816":  True,   # valley
    "Q41778911":  True,   # Ortsgemeinde of Rhineland-Palatinate
    "Q4249901":  True,   # special-status city (KR)
    "Q42523":  True,   # atoll
    "Q42723927":  True,   # city district (Scandinavian)
    "Q42744322":  True,   # urban municipality in Germany
    "Q4286337":  True,   # city district
    "Q4313794":  True,   # populated place in Georgia
    "Q43742":  True,   # oasis
    "Q4389092":  True,   # district of Moscow
    "Q44753":  True,   # province of Argentina
    "Q458063":  True,   # ancient lake
    "Q46395":  True,   # British overseas territory
    "Q467745":  True,   # union territory of India
    "Q468756":  True,   # shore
    "Q473972":  True,   # protected area
    "Q4835091":  True,   # territory
    "Q4845841":  True,   # settlement in Croatia
    "Q485258":  True,   # federative unit of Brazil
    "Q4925355":  True,   # province of South Korea
    "Q4930213":  True,   # bluebell wood
    "Q493522":  True,   # municipality of Belgium
    "Q494721":  True,   # city of Japan
    "Q4996207":  True,   # bailiwick
    "Q50256":  True,   # districts of Hong Kong
    "Q50337":  True,   # prefecture of Japan
    "Q5098":  True,   # province of Indonesia
    "Q5123999":  True,   # city of regional significance of Ukraine
    "Q514050":  True,   # fen
    "Q5153359":  True,   # municipality of the Czech Republic
    "Q518261":  True,   # cultural area
    "Q5327369":  True,   # chocho (JP city subdivision)
    "Q5398059":  True,   # Indian reservation of the United States
    "Q54050":  True,   # hill
    "Q55116":  True,   # quarter of Monaco
    "Q55237813":  True,   # village of New York
    "Q55430416":  True,   # town in Alberta
    "Q558330":  True,   # municipality of Cuba
    "Q56061":  True,   # administrative territorial entity
    "Q572995":  True,   # natural region of France
    "Q57362":  True,   # autonomous region of China
    "Q574299":  True,   # provinces of Prussia
    "Q581830":  True,   # carfree city
    "Q587089":  True,   # city with municipal rights
    "Q60458065":  True,   # city in British Columbia
    "Q6063801":  True,   # parish of Venezuela
    "Q61856889":  True,   # rural district of Schleswig-Holstein
    "Q620471":  True,   # upazila of Bangladesh
    "Q62326":  True,   # region of Denmark
    "Q6465":  True,   # department of France
    "Q662914":  True,   # district in Switzerland
    "Q667509":  True,   # municipality of Austria
    "Q674541":  True,   # low mountain range
    "Q6784672":  True,   # municipality of Slovakia
    "Q681026":  True,   # crown land of Austria
    "Q681277":  True,   # city with county rights
    "Q70208":  True,   # Municipality of Switzerland
    "Q702492":  True,   # urban area
    "Q747074":  True,   # comune of Italy
    "Q751708":  True,   # village in the United States
    "Q755707":  True,   # municipality of Norway
    "Q907116":  True,   # Monument (Spain) - heritage extent

    # Point additions:
    "Q100341898":  False,  # market municipality of Germany
    "Q1006876":  False,  # borough in the United Kingdom
    "Q1010155":  False,  # ghat
    "Q1021645":  False,  # office building
    "Q105390172":  False,  # Roman Catholic metropolitan archdiocese
    "Q105731":  False,  # lock
    "Q10594991":  False,  # nature area (specific)
    "Q106071004":  False,  # town of New York
    "Q1060829":  False,  # concert hall
    "Q106259":  False,  # polder (named polders)
    "Q10631691":  False,  # Catholic pilgrimage church
    "Q1068842":  False,  # footbridge
    "Q107679":  False,  # cliff
    "Q1081138":  False,  # historic site
    "Q108325":  False,  # chapel
    "Q10882966":  False,  # exchange building
    "Q1088552":  False,  # Catholic church building
    "Q109607":  False,  # ruins
    "Q1107656":  False,  # garden
    "Q1128397":  False,  # convent
    "Q11303":  False,  # skyscraper
    "Q1137809":  False,  # courthouse
    "Q1154710":  False,  # association football venue
    "Q11691":  False,  # stock exchange
    "Q11707":  False,  # restaurant
    "Q11755880":  False,  # residential building
    "Q11812394":  False,  # theatre company
    "Q1200957":  False,  # tourist destination
    "Q12019965":  False,  # indoor ice rink
    "Q120560":  False,  # minor basilica
    "Q1210334":  False,  # railway bridge
    "Q1220959":  False,  # building of public administration
    "Q1223230":  False,  # Roman bridge
    "Q12277":  False,  # arch
    "Q1228895":  False,  # discotheque
    "Q12292478":  False,  # estate
    "Q12323":  False,  # dam
    "Q1236923":  False,  # cathedral library
    "Q1244442":  False,  # school building
    "Q1244922":  False,  # embankment dam
    "Q124714":  False,  # spring
    "Q12493":  False,  # dome
    "Q124936":  False,  # major basilica
    "Q12518":  False,  # tower
    "Q1254933":  False,  # astronomical observatory
    "Q12570":  False,  # suspension bridge
    "Q12774":  False,  # French formal garden
    "Q12783":  False,  # English garden
    "Q1286517":  False,  # natural landscape
    "Q130003":  False,  # ski resort
    "Q13033698":  False,  # market square
    "Q131263":  False,  # barracks
    "Q131681":  False,  # reservoir
    "Q13226383":  False,  # facility
    "Q132510":  False,  # market (physical venue)
    "Q133215":  False,  # casino
    "Q13406463":  False,  # Wikimedia list article
    "Q1343246":  False,  # English country house
    "Q134626":  False,  # district capital
    "Q1359152":  False,  # sea wall
    "Q1365179":  False,  # private mansion
    "Q1378975":  False,  # convention center
    "Q139251033":  False,  # stadhuis
    "Q1401585":  False,  # medium regional center
    "Q1431958":  False,  # state room
    "Q1436181":  False,  # maison de plaisance
    "Q143912":  False,  # triumphal arch
    "Q1484611":  False,  # buurtschap
    "Q148837":  False,  # polis
    "Q1497364":  False,  # building complex
    "Q1497375":  False,  # architectural ensemble
    "Q1509716":  False,  # collegiate church
    "Q1516079":  False,  # cultural heritage ensemble
    "Q153562":  False,  # opera house
    "Q15710038":  False,  # hill castle
    "Q158218":  False,  # truss bridge
    "Q15835":  False,  # Japanese garden
    "Q158438":  False,  # arch bridge
    "Q1595408":  False,  # climatic health resort
    "Q160645":  False,  # orphanage
    "Q160742":  False,  # abbey
    "Q162602":  False,  # river island
    "Q162875":  False,  # mausoleum
    "Q163301":  False,  # Ortsbezirk of Germany
    "Q163740":  False,  # nonprofit organization
    "Q164419":  False,  # long gallery
    "Q1650922":  False,  # rural municipality
    "Q167346":  False,  # botanical garden
    "Q16735822":  False,  # history museum
    "Q16823155":  False,  # Schloss
    "Q16858213":  False,  # town in Romania
    "Q16884952":  False,  # country house
    "Q16887380":  False,  # group
    "Q16917":  False,  # hospital
    "Q169358":  False,  # stratovolcano
    "Q170980":  False,  # obelisk
    "Q173387":  False,  # grave
    "Q17343829":  False,  # unincorporated community
    "Q17431399":  False,  # national museum
    "Q174782":  False,  # square
    "Q17524420":  False,  # aspect of history
    "Q1763828":  False,  # multi-purpose hall
    "Q17715832":  False,  # castle ruin
    "Q1774587":  False,  # hospital network
    "Q1778235":  False,  # abbacy nullius
    "Q1785071":  False,  # fort
    "Q179700":  False,  # statue
    "Q180370":  False,  # hospital (Hospitallers)
    "Q180516":  False,  # room
    "Q181623":  False,  # warehouse
    "Q185113":  False,  # cape
    "Q185187":  False,  # watermill
    "Q187456":  False,  # bar
    "Q188913":  False,  # plantation
    "Q190928":  False,  # shipyard
    "Q191093":  False,  # province of South Africa
    "Q191992":  False,  # headland
    "Q192299":  False,  # county of Norway
    "Q192611":  False,  # electoral unit
    "Q1930585":  False,  # victory column
    "Q194195":  False,  # amusement park
    "Q1970365":  False,  # natural history museum
    "Q19757":  False,  # Roman theatre
    "Q19860854":  False,  # destroyed building or structure
    "Q199451":  False,  # pagoda
    "Q200334":  False,  # bell tower
    "Q202509":  False,  # Chinatown
    "Q2026833":  False,  # garden square
    "Q2031836":  False,  # Eastern Orthodox church building
    "Q2065736":  False,  # cultural property
    "Q20738676":  False,  # rural district of Baden-Württemberg
    "Q207694":  False,  # art museum
    "Q2080521":  False,  # market hall
    "Q20871353":  False,  # cadastral area in the Czech Republic
    "Q2087181":  False,  # historic house museum
    "Q21000333":  False,  # shopping street
    "Q210077":  False,  # baptistery
    "Q21010817":  False,  # city of Pennsylvania
    "Q2104072":  False,  # pontoon bridge
    "Q211302":  False,  # glacial lake
    "Q2116450":  False,  # manor estate
    "Q2154459":  False,  # New England town
    "Q216107":  False,  # department store
    "Q2194387":  False,  # neighbourhood of Brussels
    "Q2197893":  False,  # chine
    "Q2221906":  False,  # geographic location
    "Q2232001":  False,  # show cave
    "Q2264924":  False,  # port city
    "Q22687":  False,  # bank
    "Q22806":  False,  # national library
    "Q22908":  False,  # retirement home
    "Q2319498":  False,  # architectural landmark
    "Q2354973":  False,  # road tunnel
    "Q2416723":  False,  # theme park
    "Q24699794":  False,  # museum building
    "Q253019":  False,  # Ortsteil
    "Q25550691":  False,  # city hall
    "Q2613100":  False,  # Jain temple
    "Q2616791":  False,  # urban municipality of Poland
    "Q2651004":  False,  # Palazzo
    "Q267596":  False,  # ancient Greek temple
    "Q269770":  False,  # boarding school
    "Q2736554":  False,  # candi
    "Q274153":  False,  # water tower
    "Q2742167":  False,  # religious community
    "Q2749147":  False,  # castellany
    "Q2750108":  False,  # priory
    "Q27587207":  False,  # city municipality (RU)
    "Q276173":  False,  # pavilion
    "Q27686":  False,  # hotel
    "Q2772772":  False,  # military museum
    "Q2804589":  False,  # university observatory
    "Q2927789":  False,  # buitenplaats
    "Q2977":  False,  # cathedral
    "Q30014":  False,  # outer planet
    "Q3098879":  False,  # gasthuis
    "Q3147563":  False,  # capital of regency
    "Q317548":  False,  # resort town
    "Q317557":  False,  # parish church
    "Q31855":  False,  # research institute
    "Q3196771":  False,  # art museum (institution)
    "Q3250715":  False,  # province house
    "Q3253281":  False,  # artificial pond
    "Q32815":  False,  # mosque
    "Q3284499":  False,  # capitol building
    "Q328468":  False,  # Nazi concentration camp
    "Q3329412":  False,  # archaeological museum
    "Q334383":  False,  # abbey church
    "Q337986":  False,  # gurdwara
    "Q34627":  False,  # synagogue
    "Q35034452":  False,  # locality of Berlin
    "Q35509":  False,  # cave
    "Q35749":  False,  # parliament
    "Q358":  False,  # heritage site
    "Q3685462":  False,  # commune of Haiti
    "Q373074":  False,  # suffragan diocese
    "Q37654":  False,  # market (concept)
    "Q3777462":  False,  # alpine group
    "Q37901":  False,  # strait
    "Q381885":  False,  # tomb
    "Q383092":  False,  # art academy
    "Q3840711":  False,  # riverfront
    "Q38720":  False,  # windmill
    "Q38723":  False,  # higher education institution
    "Q3914":  False,  # school
    "Q3918":  False,  # university
    "Q3947":  False,  # house
    "Q3950":  False,  # villa
    "Q39614":  False,  # cemetery
    "Q3965305":  False,  # alpine subsection
    "Q39715":  False,  # lighthouse
    "Q40080":  False,  # beach
    "Q40357":  False,  # prison
    "Q41253":  False,  # movie theater
    "Q4167410":  False,  # Wikimedia disambiguation page
    "Q4260475":  False,  # medical facility
    "Q427287":  False,  # wat (Buddhist temple)
    "Q428759":  False,  # wooden bridge
    "Q4291972":  False,  # metro bridge
    "Q43229":  False,  # organization
    "Q43483":  False,  # water well
    "Q43501":  False,  # zoo
    "Q4421":  False,  # forest (named)
    "Q44539":  False,  # temple
    "Q44613":  False,  # monastery
    "Q44844":  False,  # Bismarck tower
    "Q448801":  False,  # Greater district town
    "Q45776":  False,  # fjord (named)
    "Q46112269":  False,  # rail mountain pass
    "Q46169":  False,  # national park (single named)
    "Q464780":  False,  # mint
    "Q466544":  False,  # loggia
    "Q4830453":  False,  # business
    "Q483110":  False,  # stadium
    "Q483453":  False,  # fountain
    "Q489357":  False,  # farmhouse
    "Q4946461":  False,  # spa town
    "Q498162":  False,  # census-designated place in the United States
    "Q5":  False,  # human
    "Q5003624":  False,  # memorial
    "Q5084":  False,  # hamlet
    "Q5171053":  False,  # corn exchange
    "Q5191724":  False,  # steeple
    "Q523166":  False,  # gracht
    "Q53060":  False,  # gate
    "Q5327704":  False,  # special ward of Japan
    "Q53536964":  False,  # royal palace
    "Q537127":  False,  # road bridge
    "Q5393308":  False,  # Buddhist temple
    "Q54114":  False,  # boulevard
    "Q543654":  False,  # Rathaus
    "Q55043":  False,  # gymnasium
    "Q554394":  False,  # ria
    "Q55485":  False,  # dead-end railway station
    "Q562061":  False,  # market municipality
    "Q56242063":  False,  # Protestant church building
    "Q56242215":  False,  # Catholic cathedral
    "Q56242235":  False,  # Lutheran cathedral
    "Q56242250":  False,  # Anglican or Episcopal cathedral
    "Q56395672":  False,  # Jesuit church
    "Q56436498":  False,  # village in India
    "Q570116":  False,  # tourist attraction
    "Q574990":  False,  # hofje
    "Q575759":  False,  # war memorial
    "Q57831":  False,  # fortress
    "Q597052":  False,  # commercial gallery
    "Q615810":  False,  # water castle
    "Q62049":  False,  # county seat
    "Q62098611":  False,  # museum of decorative arts
    "Q631305":  False,  # rock formation
    "Q641226":  False,  # arena
    "Q644371":  False,  # international airport
    "Q64578911":  False,  # former hospital
    "Q65177565":  False,  # former town hall
    "Q655311":  False,  # onsen
    "Q659396":  False,  # equestrian statue
    "Q66344":  False,  # central bank
    "Q676050":  False,  # old town
    "Q678552":  False,  # imperial cathedral
    "Q685204":  False,  # gate tower
    "Q685309":  False,  # former municipality of Switzerland
    "Q6882870":  False,  # designated spa town
    "Q702081":  False,  # water board in the Netherlands
    "Q7075":  False,  # library
    "Q708676":  False,  # charitable organization
    "Q7138926":  False,  # parliament building
    "Q728937":  False,  # railway line
    "Q72926449":  False,  # church tower
    "Q731966":  False,  # nymphaeum
    "Q7362268":  False,  # Roman amphitheatre
    "Q74047":  False,  # ghost town
    "Q742615":  False,  # lands of Sweden
    "Q746310":  False,  # stave church
    "Q748198":  False,  # gay village
    "Q7543083":  False,  # avenue
    "Q75520":  False,  # plateau
    "Q756102":  False,  # open-air museum
    "Q759421":  False,  # Naturschutzgebiet
    "Q777120":  False,  # borough of Pennsylvania
    "Q785952":  False,  # bathhouse
    "Q787113":  False,  # promenade
    "Q79007":  False,  # street
    "Q7969215":  False,  # ward of the City of London
    "Q797765":  False,  # inclined tower
    "Q811165":  False,  # architectural heritage monument
    "Q811430":  False,  # fixed construction
    "Q811534":  False,  # remarkable tree
    "Q811979":  False,  # architectural structure
    "Q814648":  False,  # parish of Denmark
    "Q815448":  False,  # belfry
    "Q817056":  False,  # benedictine abbey
    "Q81851":  False,  # bastion
    "Q81917":  False,  # fortified tower
    "Q820243":  False,  # Bismarck monument
    "Q820254":  False,  # mining community
    "Q82117":  False,  # city gate
    "Q828909":  False,  # wharf
    "Q83620":  False,  # thoroughfare
    "Q840482":  False,  # shrine of Our Lady
    "Q842402":  False,  # Hindu temple
    "Q860861":  False,  # sculpture
    "Q863454":  False,  # pier
    "Q875538":  False,  # public university
    "Q879050":  False,  # manor house
    "Q88291":  False,  # citadel
    "Q894436":  False,  # bosquet
    "Q902104":  False,  # private university
    "Q902814":  False,  # border city
    "Q907698":  False,  # prospekt
    "Q91312":  False,  # tower house
    "Q91325574":  False,  # Trappist monastery
    "Q917182":  False,  # military academy
    "Q9259":  False,  # World Heritage Site (specific)
    "Q947103":  False,  # watchtower
    "Q949819":  False,  # ship canal
    "Q954501":  False,  # natural arch
    "Q955824":  False,  # learned society
    "Q959309":  False,  # coal mine
    "Q965568":  False,  # kelurahan
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
