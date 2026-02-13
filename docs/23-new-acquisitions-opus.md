> **Prompt:** Has the Rijksmuseum recently acquired any works that would be relevant to ongoing research, and how can researchers monitor new additions?
>
> **MCP client:** Claude Code | **Model:** Claude Opus 4.6 (extended thinking, medium effort) | **Tools used:** `get_recent_changes`, `get_artwork_details` | **Turns:** 4

---

## Monitoring New Acquisitions and Catalogue Updates at the Rijksmuseum

### The Change Feed

The `get_recent_changes` tool provides a date-filtered feed of all additions and modifications to the Rijksmuseum's catalogue. Querying from 1 November 2025 to the present returns **836,810 records** — a figure that represents the total catalogue size, since the OAI-PMH endpoint returns all records modified since the given date.

### Recent Activity (Sample)

A sample of 10 recently modified records reveals the range of cataloguing activity:

| Object Number | Title | Date | Type | Materials |
|--------------|-------|------|------|-----------|
| RP-P-2010-222-3315 | *Before, Behind, Between, Above, Below* | 1973 | print | paper |
| RP-P-2017-2033-37 | *Badende jongens* | 1947 | print | paper |
| RP-P-1906-2550 | Portrait of Dirk I, Count of Holland | 1620 | print | paper |
| KOG-MP-1-4280 | Mexican peso with Chinese characters | 1863-1900 | coin | silver |
| KOG-MP-2-1956 | Medal of Queen Wilhelmina | 1890-1898 | medal | brass |
| KOG-MP-2-1957 | Crown Prince at Waterloo 1815 | 1815 | medal | brass |
| KOG-MP-1-4281 | Korean 2 chon coin | 1882-1883 | coin | silver |
| KOG-MP-2-1958 | Willem III jubilee medal | 1874 | medal | brass |
| KOG-MP-2-1959 | Willem III Franco-Prussian War medal | 1870-71 | medal | brass |
| KOG-MP-2-1960 | Medal of Queen Wilhelmina | 1890-1898 | medal | brass |

### What the Feed Shows

The sample reveals several categories of activity:

1. **Print collection enrichment**: Recent additions include 20th-century prints (Nicolaas Wijnberg) and newly catalogued historical prints. The object number prefix `RP-P-2017-2033-` and `RP-P-2022-107-` suggest recent acquisitions being processed into the catalogue.

2. **Numismatic cataloguing**: A batch of coins and medals (KOG-MP prefix) from the Royal Coin Cabinet, including internationally diverse objects — a Mexican peso with Chinese trade marks, a Korean coin, and Dutch commemorative medals. These records were all modified on the same date (28 January 2026), suggesting a systematic cataloguing campaign.

3. **Metadata updates**: The `datestamp` field shows when each record was last modified, not when it was first created. Changes may reflect new provenance information, revised attributions, updated descriptions, or digitisation (addition of IIIF image links).

### How Researchers Can Use This

#### Periodic Monitoring

A researcher studying, for example, 18th-century decorative arts could:

1. Run `get_recent_changes` with a date range covering the last month or quarter
2. Use `identifiersOnly: true` for a lightweight scan (returns just object numbers and datestamps)
3. Filter by set membership if a relevant curated set exists
4. Follow up with `get_artwork_details` on promising new entries

#### Identifying New Acquisitions vs. Metadata Updates

The feed does not distinguish between new acquisitions and updates to existing records. To identify genuinely new objects:
- Look for recent object number prefixes (e.g., `RP-P-2022-*`, `NG-2024-*`)
- Check the credit line in `get_artwork_details` — recent gifts and purchases will have contemporary donor names or acquisition dates
- Monitor specific curated sets for growing member counts

#### Tracking Specific Research Areas

For targeted monitoring:
- Use the `setSpec` parameter to restrict changes to a specific curated set (e.g., Japanese collection, prints)
- Combine with date filtering to catch only recent additions to your area of interest
- The resumption token supports pagination through large result sets

### Limitations

- **No "new only" filter**: The OAI-PMH endpoint does not separate new records from modified ones. A record that was merely re-indexed appears alongside a genuine new acquisition.
- **Batch processing artefacts**: When the museum runs a bulk catalogue update (as with the coin collection above), hundreds of records may appear with the same datestamp, even if the objects themselves are not new.
- **No push notifications**: The tool requires active polling. Researchers must remember to check periodically; there is no subscription or alert mechanism.
- **Granularity**: The feed shows *that* a record changed, but not *what* changed. To determine whether a provenance field was updated or an image was added, you need to compare the current record with a previous snapshot.

### Practical Recommendation

For researchers who need to stay current with Rijksmuseum catalogue developments, a monthly check of `get_recent_changes` with `identifiersOnly: true` provides an efficient scan. Flag records with recent object number prefixes for closer inspection, and use `get_artwork_details` to assess whether new entries are relevant to your research.
