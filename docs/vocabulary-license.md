# License Values

3 distinct license designations across ~833,000 artworks.

| Value | Rights URI | Artworks |
|---|---|---|
| `publicdomain` | `http://creativecommons.org/publicdomain/mark/1.0/` | ~730,000 |
| `InC` | `http://rightsstatements.org/vocab/InC/1.0/` | ~101,500 |
| `zero` | `http://creativecommons.org/publicdomain/zero/1.0/` | 1,728 |

276 artworks have no license designation.

**Usage:** License is not a `search_artwork` filter. The value (`publicdomain`, `zero`, or `InC`) is returned as the `license` field on each `search_artwork` / `get_artwork_details` result. For a license breakdown of a result set, request the `rights` dimension via `search_artwork`'s `facets` parameter (e.g. `facets: ["rights"]`).
