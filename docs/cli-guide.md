# Rijksmuseum MCP+ CLI Guide

A headless command-line interface over the Rijksmuseum MCP server's stateless tools.

The CLI ships as `scripts/cli.mjs`, runnable directly, via `npm run cli`, or as the installed
`rijks-mcp` bin (see [Invocation](#invocation)). It is an MCP **client** — it drives the existing
server rather than reimplementing any search logic. A CLI query therefore returns *exactly* what an
LLM would get from the same tool, which makes it both a power-user/pipeline tool and a debugging /
protocol regression harness. It is JSON-first, designed for shell pipelines and bash-capable agents.

All examples below are real and were run against the production vocabulary database
(roughly 830K artworks). Counts and IDs were re-verified against the current harvest and may shift after the next one.

---

## Contents

- [Invocation](#invocation)
- [Transports (warm HTTP vs cold stdio)](#transports)
- [Output model](#output-model)
- [Flags & argument conventions](#flags--argument-conventions)
- [Discovery & introspection](#discovery--introspection)
- [Command reference](#command-reference)
- [Pipeline recipes](#pipeline-recipes)
- [Worked example: Waller's collector's mark](#worked-example-wallers-collectors-mark)
- [Using the CLI from an agent](#using-the-cli-from-an-agent)
- [Troubleshooting](#troubleshooting)

---

## Invocation

Three equivalent entry points:

```bash
node scripts/cli.mjs <command> [args] [flags]     # direct (used throughout this guide)
npm run cli -- <command> [args] [flags]           # via package script (note the `--`)
rijks-mcp <command> [args] [flags]                # via the installed bin (after `npm link` / global install)
```

The `npm run cli` form needs `--` before tool flags so npm doesn't swallow them. The bare
`node scripts/cli.mjs` form is simplest and is what the rest of this guide uses. To enable the
`rijks-mcp` form, link the bin onto your `PATH` once with `npm link` (or `npm install -g .`) from
the repo root; all three forms are otherwise identical.

**Scope.** The CLI exposes the 15 stateless tools. The four viewer/stateful tools
(`get_artwork_image`, `navigate_viewer`, `remount_viewer`, `poll_viewer_commands`) depend on the
live viewer iframe and are intentionally excluded — invoking one is a usage error (exit 2).

---

## Transports

One `invoke()` seam, two backends. Pick with `--http` (or the `RIJKS_MCP_HTTP` env var):

| Mode | How | When |
|---|---|---|
| **HTTP** (recommended) | `--http <url>` or `RIJKS_MCP_HTTP=<url>` | A server is already running (`npm run serve` or Railway). It's warm, so every call is instant. |
| **stdio** (default) | no `--http` | Zero-config one-off. Spawns `node dist/index.js` as a subprocess. Requires `npm run build` + the DBs in `data/`. |

```bash
# HTTP — against a warm local server (start it with: npm run serve)
node scripts/cli.mjs --http http://localhost:3000/mcp search --query "tulip" --max 5
export RIJKS_MCP_HTTP=https://rijksmuseum-mcp-plus-production.up.railway.app/mcp
node scripts/cli.mjs search --query "tulip" --max 5          # now uses HTTP automatically

# stdio — no server needed
node scripts/cli.mjs search --query "tulip" --max 5
```

### Cold-start cost

The CLI's stdio transport sets `MCP_SKIP_STARTUP_WARM=1`, so a cold one-shot skips the server's
eager warm-up. Caches instead build **lazily on first use**:

- Plain vocab queries (`search`, `details`, `stats`, `persons`, `provenance`) → **~1 s**.
- First `semantic` / `similar` call → relocates the ~8 s embeddings page-in to that call.
- First `list-sets` / `browse-set` call → builds the curated-sets cache (~9 s) on that call.

An HTTP server pays the same embeddings and curated-sets costs on its own first such call — a
completed boot no longer implies they are warm. Once a given server has served one of each, they
don't recur for its lifetime, which is why HTTP is still the better choice for repeated/agent use.

---

## Output model

**stdout is the data channel; stderr is the human/diagnostic channel.** This keeps stdout pure and
`jq`-clean.

| What | Goes to |
|---|---|
| Result rows (list tools) | **stdout**, one JSON object per line (JSONL) |
| Single-object results (`details`, `similar`, `inspect` metadata) | **stdout**, one compact JSON object |
| Count + pagination hint + `note:` lines + `warnings` | **stderr** |
| Server warn/error log lines for a failed call — *stdio mode only* | **stderr** |

**`note:` lines** restate caveats that the tool's text summary carries but JSONL rows can't: a
capped or partial total (`search_provenance`, `search_inscriptions`), compact summaries returned in
place of full chains, credit-line matches that aren't parsed provenance, artworks that fall in no
`stats` bucket, multi-valued `stats` dimensions, and top-level keys such as `facets` that sit
outside the rows (pass `--json` to read them).

In stdio mode the server's own log is captured, not passed through: a successful call leaves stderr
to the CLI. When a call or the connection fails, the server's warn/error lines from that call are
appended to the error (skipping any that only repeat it).

### Output flags

| Flag | Effect |
|---|---|
| *(default)* | JSONL for lists, compact JSON for single objects |
| `--json` | Print the entire `structuredContent` payload, pretty-printed (verbatim — no list-splitting, no projection) |
| `--table` | Terse human-readable table (opt-in) |
| `--fields a,b,c` | Project to these top-level keys on every emitted object — the biggest token saver |
| `--quiet` | Suppress the stderr summary and `note:` lines |
| `-o` / `-h` | Short aliases for `--out` and `--help` |

**Flag spelling.** Tool parameters are camelCase, but you may write them in kebab-case: `--resumption-token` and `--resumptionToken` are equivalent, as are `--include-extent-text` and `--includeExtentText`. The kebab form is resolved only when the camelCase name is a real parameter of that command, so CLI-owned flags like `--show-call` are never mistaken for tool arguments.

```bash
# Default: JSONL, one object per line
$ node scripts/cli.mjs search --creator "Rembrandt van Rijn" --type painting --max 2 --fields objectNumber,title
{"objectNumber":"SK-C-5","title":"The Night Watch Militia Company of District II under the Command of Captain Frans Banninck Cocq"}
{"objectNumber":"SK-C-6","title":"The Sampling Officials of the Amsterdam Drapers’ Guild, Known as ‘The Syndics’"}
# (on stderr)  2 shown (offset 0) of 34; pass --offset 2 for more

# Table for eyeballing
$ node scripts/cli.mjs stats type --max 5 --fields label,count --table
label                  count
---------------------  ------
print                  369054
photograph             133804
drawing                56763
photomechanical print  52428
carte-de-visite        17979
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Tool error or connection failure (the server's prose error — e.g. "no results; try the Dutch term" — is written to stderr) |
| `2` | Usage error — unknown command, an out-of-scope viewer tool, an unknown flag (with a "Did you mean" hint for punctuation/case slips), a missing required parameter, a flag with no value, an extra positional, `--max` on a command with no cap, or a malformed JSON value. These are checked against the live schema before the call, so `--show-call` also rejects them. A flag the schema knows but whose *value* it rejects (e.g. an unknown `stats` dimension) is a **tool** error, exit `1`. |

### Batch mode (`--stdin`)

`--stdin` reads lines from stdin and runs **one invocation per line over a single
connection** — each line becomes the command's primary positional. This amortizes the stdio
cold-start (one warm child instead of one process per input) and is the natural way for an agent
or pipeline to fan a verb over many inputs. Blank lines and `#`-comment lines are skipped; every
other flag (`--fields`, `--json`, `--max`, …) applies to each line. Output stays JSONL on stdout,
in input order; per-line errors go to stderr prefixed with the offending token.

```bash
$ printf 'SK-C-5\nSK-A-1115\n' | node scripts/cli.mjs details --stdin --fields objectNumber,title
{"objectNumber":"SK-C-5","title":"The Night Watch …"}
{"objectNumber":"SK-A-1115","title":"The Battle of Waterloo"}
```

The batch exit code is `0` only if every line succeeded, `1` if any line errored (the other lines
still emit; a `N of M input(s) failed` summary goes to stderr), and `2` for a usage error — e.g.
`--stdin` on a command with no positional, or with no piped input (a bare TTY exits `2` rather than
hanging on the keyboard).

---

## Flags & argument conventions

- **Positionals.** The first positional maps to each command's primary parameter (e.g.
  `details SK-C-5` ≡ `details --objectNumber SK-C-5`; `semantic "a storm"` ≡ `semantic --query "a storm"`).
- **Flag forms.** `--flag value` and `--flag=value` both work. Values may start with `-`
  (e.g. `--nearLat -33.8`).
- **Arrays.** Repeat a flag to build an array: `--type print --type drawing`. Schema array fields
  also accept a single value (auto-wrapped).
- **Booleans.** Presence = true: `--identifiersOnly`. Explicit `--imageAvailable=false` also works.
- **Coercion.** Numeric and boolean flags are coerced per the live schema, so `--max 20` (a string
  on the command line) is accepted where the tool wants a number.
- **Objects (JSON).** A few params are structured objects (currently the `search` `textQuery` DSL).
  Pass them as a single JSON literal — `--textQuery '{"must":[…]}'` — which the CLI parses before
  sending. `--help` shows these as `<json>`; malformed JSON is a usage error (exit 2) naming the flag.

### `--max` maps to each command's own cap

`--max` (and `-n`) resolves to whichever parameter caps that command's results: `topN` for `stats`,
`maxResults` for every other capped command. Commands without a cap reject it as a usage error
(exit 2):

| Command | Result cap |
|---|---|
| `stats` | `--max` → `topN` |
| `list-sets` | none — narrow with `--query` / `--minMembers` / `--maxMembers` |
| `bibliography`, `citing` | none — `--full` returns all (first 5 / first 20 plus a total by default) |
| `details`, `conservation`, `inspect` | none — single-object lookups |
| everything else | `--max` → `maxResults` |

When in doubt, `node scripts/cli.mjs <command> --help` lists the real flags (generated from the
live schema, so it never drifts).

---

## Discovery & introspection

```bash
node scripts/cli.mjs                       # top-level usage (curated; renders offline, never connects)
node scripts/cli.mjs help                  # same
node scripts/cli.mjs <command> --help      # one command's flags + example, from the live schema
                                           #   (degrades to a static summary + hint when no server)
node scripts/cli.mjs tools                 # verb → tool name table
node scripts/cli.mjs tools --compact       # compact capability manifest — the agent bootstrap
node scripts/cli.mjs tools --json          # full input/output schema dump — deep introspection only
node scripts/cli.mjs <command> --show-call # print the resolved {tool, arguments} WITHOUT executing
```

`tools --compact` is the agent bootstrap — a small JSON manifest (one entry per tool: `verb`, `tool`,
`positional`, `result` shape, optional `page` mode, optional `max` (the parameter `--max` maps to),
and `args` as name→type, with a trailing `!` marking required args). It's the CLI equivalent of MCP `tools/list` but ~30× smaller than
`tools --json`, which dumps every tool's full input *and* output JSON Schema — reserve that for deep
introspection. Both derive from the live schema, so neither drifts from the server.

```bash
$ node scripts/cli.mjs tools --compact | jq '.[] | select(.tool=="find_similar")'
{
  "verb": "similar",
  "tool": "find_similar",
  "positional": "objectNumber",
  "result": "single",
  "max": "maxResults",
  "args": { "objectNumber": "string!", "maxResults": "number", ... }
}
```

`--show-call` lets an agent verify its argument mapping cheaply before spending a real call:

```bash
$ node scripts/cli.mjs --show-call search --query "tulip" --type print --max 10
{
  "tool": "search_artwork",
  "arguments": {
    "query": "tulip",
    "type": [ "print" ],
    "maxResults": 10
  }
}
```

---

## Command reference

| Verb | Tool | Positional | Result cap | List key | Pagination |
|---|---|---|---|---|---|
| `search` | `search_artwork` | `query` | `--max` | `results` | offset |
| `semantic` | `semantic_search` | `query` | `--max` | `results` | offset |
| `multimodal` | `multimodal_search` | `query` | `--max` | `results` | offset |
| `persons` | `search_persons` | `name` | `--max` | `persons` | offset |
| `provenance` | `search_provenance` | `party` | `--max` | `results` | offset |
| `inscriptions` | `search_inscriptions` | `text` | `--max` | `results` | offset |
| `details` | `get_artwork_details` | `objectNumber` | — (single) | — | — |
| `bibliography` | `get_artwork_bibliography` | `objectNumber` | `--full` | `entries` | — |
| `citing` | `find_artworks_citing_publication` | `publication` | `--full` | `artworks` | — |
| `conservation` | `get_conservation_history` | `objectNumber` | — (single) | — | — |
| `stats` | `collection_stats` | `dimension` | `--max` (→ `topN`) | `entries` | offset |
| `similar` | `find_similar` | `objectNumber` | `--max` | — (single) | — |
| `browse-set` | `browse_set` | `setSpec` | `--max` | `records` | token |
| `list-sets` | `list_curated_sets` | — | — | `sets` | — |
| `changes` | `get_recent_changes` | — | `--max` | `records` | token |
| `inspect` | `inspect_artwork_image` | `objectNumber` | — (single) | — | — |

Offset paging: pass `--offset <n>` (the stderr summary tells you the next value).
Token paging: pass `--resumption-token <tok>` (likewise surfaced on stderr).

---

### `search` → `search_artwork`

Structured filters; all combine (array values AND-combined). Returns up to 25 (max 50). Full filter
list via `search --help` (30+ filters: title, creator, subject, type, material, technique, dates,
place hierarchy, geo proximity, themes, …).

```bash
# By creator + type
$ node scripts/cli.mjs search --creator "Rembrandt van Rijn" --type painting --max 3 --fields objectNumber,title,date
{"objectNumber":"SK-C-5","title":"The Night Watch ...","date":"1642"}
...
# stderr: 3 shown (offset 0) of 34; pass --offset 3 for more

# Title keyword, pull the next page
node scripts/cli.mjs search --query "tulip" --type print --max 10
node scripts/cli.mjs search --query "tulip" --type print --max 10 --offset 10

# Feed a person vocabId (from `persons`) as the creator for precise, name-spelling-proof matching
node scripts/cli.mjs search --creator 2103429 --type painting --max 5 --fields objectNumber,title

# Advanced structured text search — textQuery is an object, so pass a JSON literal
node scripts/cli.mjs search \
  --textQuery '{"must":[{"field":"title","phrase":"tulip"},{"field":"description","prefix":"land"}]}' \
  --max 5 --fields objectNumber,title
```

Output keys: `totalResults`, `results`, `source`. Each result: `objectNumber`, `title`, `creator`,
`date`, `type`, `url`. The `textQuery` DSL (multi-field boolean: `must`/`should`, `phrase`, `any`,
`prefix`, `near`, …) is an object — see its full shape via `search --help`.

---

### `semantic` → `semantic_search`

Meaning/concept search (natural language). Ranked by similarity; returns up to 15 (max 50). Accepts
a *subset* of `search`'s pre-filters (`--type`, `--material`, `--technique`, `--creator`,
`--creationDate`, `--subject`, `--iconclass`, `--depictedPerson`, `--depictedPlace`,
`--productionPlace`, `--collectionSet`, `--aboutActor`, `--imageAvailable`) — notably **not**
`--textQuery`, `--sort`, `--facets`, the dimension ranges, or the geo filters. Run
`semantic --help` for the authoritative list.

```bash
$ node scripts/cli.mjs semantic "ships in a stormy sea" --max 3 --fields objectNumber,title,similarityScore --table
objectNumber    title                          similarityScore
--------------  -----------------------------  ---------------
RP-T-00-1672    Twee schepen op zee bij storm  0.87
RP-P-OB-29.978  Schepen op stormachtige zee    0.865
RP-P-OB-15.176  Zeilsschepen in storm op zee   0.859
```

Output keys: `searchMode`, `query`, `returnedCount`, `results`. Each result adds `rank`,
`similarityScore`, and `sourceText` (the reconstructed text the ranking saw — useful for grounding).

---

### `persons` → `search_persons`

Search the person and group authority records by name, gender, birth year, birth/death place, or
profession (there is no death-year filter). Returns `vocabId`s to feed into `search --creator <vocabId>` (works *by*) or
`search --depictedPerson <name>` (works *depicting*; this filter takes a name, not a vocabId).

```bash
$ node scripts/cli.mjs persons "Rembrandt" --max 2 --fields vocabId,label,birthYear,deathYear,artworkCount --table
vocabId    label                birthYear  deathYear  artworkCount
---------  -------------------  ---------  ---------  ------------
2103429    Rijn, Rembrandt van  1606       1669       3717
210159785  Rembrandt Peale      ...

# Demographic filter then count by hand-off to search/stats
node scripts/cli.mjs persons --gender female --profession painter --bornAfter 1850 --max 20 --fields vocabId,label
```

Output keys: `totalResults`, `persons`. Each person: `vocabId`, `label`, `labelEn`, `labelNl`,
`birthYear`, `deathYear`, `gender`, `artworkCount`, `wikidataId`.

---

### `provenance` → `search_provenance`

Ownership history across artworks with parsed provenance. Filter by `--party`, `--transferType`,
`--location`, date range, price, gaps. Two layers: `--layer events` (default) and `--layer periods`.

```bash
# Works whose provenance mentions the Six family
node scripts/cli.mjs provenance --party "Six" --max 3 --fields objectNumber,title,matchedEventCount

# Acquisitions by gift, as interpreted ownership periods
node scripts/cli.mjs provenance --transferType gift --layer periods --max 5
```

Output keys: `totalArtworks`, `results`, `facets`/`warnings` depending on layer, plus `totalArtworksCapped`, `creditLineResults` and `autoCompacted` where applicable. `periods` is nested inside each result, not top-level.
When events contain LLM-assisted records, an `enrichmentReview` (`{ count, url | file }`) also
rides the result — the review-page link, mirroring the `REVIEW_URL`/`REVIEW_FILE` text line.
Each result: `objectNumber`, `title`, `creator`, `date`, `url`, `eventCount`, `matchedEventCount`,
`events`.

---

### `inscriptions` → `search_inscriptions`

Structured search over on-object text — collector's marks, signatures, and transcribed inscriptions.
The positional maps to `--text` (a blunt full-text match over the whole inscription blob); narrower
flags target the parsed structure: `--transcribedText` (quoted text only — signatures, captions),
`--collectorMark` (Lugt catalogue reference, e.g. `Lugt 240` or just the number), `--inscriptionType`,
`--placement` (`recto`/`verso`), `--technique`, plus `--hasTranscribedText` /
`--excludeCollectorMarkOnly` / `--isPlaceholder` boolean refiners. Offset paging.

```bash
# Works whose transcribed text mentions Rembrandt (signatures, captions)
$ node scripts/cli.mjs inscriptions --transcribedText "Rembrandt" --max 3 --fields objectNumber,title
{"objectNumber":"KOG-AA-2-2-16A","title":"Gezicht op Volewijk"}
{"objectNumber":"SK-C-5","title":"The Night Watch ..."}
{"objectNumber":"SK-C-6","title":"The Sampling Officials ..."}

# By Lugt collector-mark reference
node scripts/cli.mjs inscriptions --collectorMark "Lugt 240" --max 5 --fields objectNumber,title

# Drop pure collector-mark boilerplate, keep only works with real transcribed text
node scripts/cli.mjs inscriptions --hasTranscribedText --excludeCollectorMarkOnly --max 10
```

Output keys: `totalConfirmed`, `totalCandidates`, `candidatesCapped`, `results`. Each result:
`objectNumber`, `title`, `creator`, `date`, `url`, `matchedInscriptions`. Cap with `--max` (1–100,
default 20); page with `--offset`.

---

### `details` → `get_artwork_details`

Full metadata for one object — the complete record, 46 top-level fields. Single-object output. Pair
with `--fields` to keep it small.

```bash
$ node scripts/cli.mjs details SK-C-5 --fields objectNumber,title,creator,date,type
{"objectNumber":"SK-C-5","title":"The Night Watch ...","creator":"Rembrandt van Rijn","date":"1642","type":"painting"}

# Full record, pretty
node scripts/cli.mjs details SK-C-5 --json | jq '.provenanceChain'
```

Note the field rename in recent versions: physical dimensions are under `physicalDimensions` (was
`dimensionStatement`).

---

### `bibliography` → `get_artwork_bibliography`

Scholarly references for one artwork — citations with the linked publication, pages, and ISBN where
known. Default returns the first 5 entries + a `total` count; `--full` returns all (major works can
carry 100+).

```bash
$ node scripts/cli.mjs bibliography SK-C-5 --fields sequence,citation
{"sequence":1,"citation":"Anne Lenders, 'Short notice. The Dog in The Night Watch ...', The Rijksmuseum Bulletin 73 (2025) nr. 3, p. 212-223."}
...
# stderr: 5 shown of 111; pass --full for all

# All entries; pull just the linked-publication URIs
node scripts/cli.mjs bibliography SK-C-5 --full --json | jq -r '.entries[].publicationUri | select(. != null)'
```

Output keys: `objectNumber`, `total` (e.g. 111 for SK-C-5), `entries`. Each entry: `sequence`,
`citation`, `publicationUri` (the linked publication record, or null for inline-only citations),
`publicationId` (the bare id from that URI, ready for `citing`), `pages`, `isbn`, `worldcatUri`,
`libraryUrl`.

---

### `citing` → `find_artworks_citing_publication`

The reverse of `bibliography` — artworks whose references cite a given publication. Pass the
`publicationUri` from a bibliography entry (or the bare numeric id). Default returns the first 20 +
a `total` count; `--full` returns all.

```bash
$ node scripts/cli.mjs citing https://id.rijksmuseum.nl/301154354 --fields objectNumber,title,creator
{"objectNumber":"RP-P-OB-20.603","title":"Portret van dr. Gachet","creator":"Vincent van Gogh"}
...
# stderr: 19 shown of 19

# The bare id works too
node scripts/cli.mjs citing 301154354 --full --fields objectNumber,creator
```

Output keys: `publicationUri`, `publicationId`, `total`, `artworks`. Each artwork: `objectNumber`,
`title`, `creator`.

---

### `conservation` → `get_conservation_history`

Forensics record for one artwork — technical examinations (X-ray, dendrochronology, infrared, paint
samples), restoration/conservation treatments, a count of signature/inscription marks, and a
provenance excerpt. Single-object output.

```bash
$ node scripts/cli.mjs conservation SK-A-110 --json | jq '{title, examinationsTotalCount, conservationHistoryTotalCount}'
{"title":"Isaak zegent Jakob","examinationsTotalCount":15,"conservationHistoryTotalCount":5}

# Just the technical examinations (report type, examiner, date)
$ node scripts/cli.mjs conservation SK-A-110 --json | jq -c '.examinations[] | {reportTypeLabel, examiner, date}'
{"reportTypeLabel":"infrared photography","examiner":"G. Tauber","date":"2010-09-09"}
...
```

Output keys: `objectNumber`, `title`, `creator`, `examinations` (+`examinationsTotalCount`),
`conservationHistory` (+`conservationHistoryTotalCount`), `attributionMarks`
(`{signatures, inscriptions, total}`), `provenanceTextSummary`. A work with no records returns a
`warnings` note on stderr.

---

### `stats` → `collection_stats`

Aggregate counts/distributions across a dimension. **Cap with `--topN`, not `--max`.** Artwork and
provenance dimensions; filters compose (`--type`, `--creator`, `--productionPlace`, …).

```bash
$ node scripts/cli.mjs stats type --max 5 --fields label,count --table
label                  count
---------------------  ------
print                  369054
photograph             133804
drawing                56763
photomechanical print  52428
carte-de-visite        17979

# Distribution of a single creator's output by decade
node scripts/cli.mjs stats decade --creator "Rembrandt van Rijn" --table
```

Output keys: `dimension`, `total` (denominator, e.g. 834435), `totalBuckets` (632 distinct types),
`coverage`, `entries`, `appliedFilters`, … Each entry: `label`, `count`, `percentage`. Page entries
with `--offset`.

---

### `similar` → `find_similar`

Artwork-to-artwork similarity across nine signals plus a Pooled consensus. Single-object output
(the payload isn't a flat list — `--fields` projects its top-level keys).

```bash
# Which signal channels fired, and how many pooled-consensus matches
node scripts/cli.mjs similar SK-C-5 --max 10 --json | jq '{modes: (.modes|keys), pooled: (.pooled|length)}'

# Just the visual neighbours
node scripts/cli.mjs similar SK-C-5 --max 10 --json | jq '.modes.visual[] | {objectNumber, title}'
```

Output keys: `query`, `modes` (per-channel arrays: `visual`, `description`, `iconclass`, `lineage`,
`theme`, `relatedVariant`, `relatedObject`, `depictedPerson`, `depictedPlace`), `pooled`,
`poolThreshold`, `pageUrl` (link to the rendered HTML comparison page), `generatedAt`. The payload
is large (~6 k tokens at `--max 20`); use `--fields` / `jq`.

---

### `browse-set` → `browse_set`

Enumerate the members of a curated set. Token pagination.

```bash
$ node scripts/cli.mjs browse-set 2619 --max 2 --include-extent-text --fields objectNumber,title,extentText
{"objectNumber":"...","title":"...","extentText":"..."}
...
# stderr: 2 shown of 139; pass --resumption-token MjYxOQky for more

node scripts/cli.mjs browse-set 2619 --resumption-token MjYxOQky --max 2
```

Output keys: `records`, `totalInSet`, `resumptionToken`. Each record: `objectNumber`, `title`,
`creator`, `date`, `extentText` (was `dimensions`; only when `--include-extent-text` is passed), `datestamp`, `hasImage`, `imageUrl`,
`iiifServiceUrl`, `edmType`, `lodUri`, `url`.

---

### `list-sets` → `list_curated_sets`

Discover the 193 curated sets. **No `--max`** — filter with `--query`, `--minMembers`,
`--maxMembers`, `--sortBy`.

```bash
$ node scripts/cli.mjs list-sets --query "Rembrandt" --fields setSpec,name,memberCount --table
setSpec  name                                                memberCount
-------  --------------------------------------------------  -----------
2619     Drawings by Rembrandt and his School in the ...     139
...

# Substantive subsets only (exclude the 834K umbrella set), smallest first
node scripts/cli.mjs list-sets --minMembers 100 --maxMembers 200000 --sortBy size --fields setSpec,name,memberCount
```

Output keys: `totalSets`, `filteredFrom`, `query`, `sets`. Each set: `setSpec`, `name`, `lodUri`,
`memberCount`, `dominantTypes`, `dominantCenturies`, `category`.

---

### `changes` → `get_recent_changes`

Additions/modifications by date range. `--identifiersOnly` returns lightweight headers (much
faster). Token pagination.

```bash
$ node scripts/cli.mjs changes --from 2024-01-01 --identifiersOnly --max 3 --fields identifier,datestamp
{"identifier":"https://id.rijksmuseum.nl/2001","datestamp":"2026-06-09T10:19:51Z"}
...
# stderr: 3 shown of 842048; pass --resumption-token <uuid> for more

node scripts/cli.mjs changes --resumption-token <uuid> --identifiersOnly --max 3
```

Output keys: `returnedCount`, `totalChanges`, `identifiersOnly`, `records`, `resumptionToken`,
`hint`. Header records: `identifier`, `datestamp`, `setSpecs`. (Full EDM records when
`--identifiersOnly` is omitted.)

---

### `inspect` → `inspect_artwork_image`

Fetch an image region as bytes for visual analysis. Regions: `full`, `square`, `x,y,w,h` (pixels),
`pct:x,y,w,h` (percent), `crop_pixels:x,y,w,h`. **Use `--out <file>` to save the bytes** (extension
inferred from the mime type when omitted).

```bash
# Save a region to disk (a multimodal agent can then read the file back)
$ node scripts/cli.mjs inspect SK-C-5 --region "pct:40,40,15,15" --out crop.jpg
# stderr: Wrote crop.jpg (image/jpeg)

# Without --out: prints metadata only; bytes are NOT dumped to stdout
$ node scripts/cli.mjs inspect SK-C-5 --region "pct:40,40,15,15"
{"objectNumber":"SK-C-5","region":"pct:40,40,15,15","requestedSize":1568,"nativeWidth":14645,"nativeHeight":12158,"cropPixelWidth":1568,"cropPixelHeight":1302,...}
# stderr: Image bytes available (image/jpeg); pass --out <file> to save them.
```

Metadata keys: `objectNumber`, `title`, `creator`, `region`, `requestedSize`, `nativeWidth`,
`nativeHeight`, `cropPixelWidth`, `cropPixelHeight`, `cropRegion`, `rotation`, `quality`, `fetchTimeMs`.
On an out-of-bounds region the (error) result instead carries `regionRecovery` (`requested`,
`clampedTo`, `validRange`) for self-correction.

---

## Pipeline recipes

Because lists are JSONL on stdout, the usual Unix tools compose:

```bash
# Top 10 object types as a count table
node scripts/cli.mjs stats type --max 10 --fields label,count | jq -r '[.label, .count] | @tsv'

# All Rembrandt paintings' object numbers, one per line
node scripts/cli.mjs search --creator 2103429 --type painting --max 50 --fields objectNumber \
  | jq -r '.objectNumber'

# Resolve a name → vocabId → count works
VID=$(node scripts/cli.mjs persons "Vermeer" --max 1 --fields vocabId | jq -r '.vocabId')
node scripts/cli.mjs search --creator "$VID" --max 50 --fields objectNumber,title

# Semantic search, keep only high-confidence hits
node scripts/cli.mjs semantic "winter landscape with skaters" --max 50 \
  | jq -c 'select(.similarityScore > 0.85) | {objectNumber, title}'

# Fan out: pull details for each search hit (one CLI process per object number)
node scripts/cli.mjs search --query "self-portrait" --max 5 --fields objectNumber \
  | jq -r '.objectNumber' \
  | while read on; do node scripts/cli.mjs details "$on" --fields objectNumber,title,date; done

# Same fan-out, one connection: pipe the object numbers straight into --stdin batch mode
node scripts/cli.mjs search --creator 2103429 --type painting --max 50 --fields objectNumber \
  | jq -r '.objectNumber' \
  | node scripts/cli.mjs details --stdin --fields objectNumber,title,date
```

Errors and counts go to stderr, so they never corrupt a `| jq` pipe. Add `--quiet` to silence the
count summary entirely.

---

## Worked example: Waller's collector's mark

[Research scenario 9](research-scenarios.md#9-fg-wallers-collectors-mark-lugt-2760) asks whether the collector's mark of F.G. Waller (Lugt 2760) identifies his personal collection. Answering it properly means joining every stamped sheet to its credit line, but the mark sits on some 33,000 sheets, far more than a chat session can handle. The shell can do the join:

```bash
export RIJKS_MCP_HTTP=http://localhost:3000/mcp        # a warm server (npm run serve); stdio would spawn per call

# 1. every sheet bearing the mark → one object number per line (100 per page, 200 pages)
for off in $(seq 0 100 19900); do
  rijks-mcp inscriptions --collectorMark 2760 --max 100 --offset $off --fields objectNumber
done | jq -r .objectNumber > waller-marked.txt

# 2. the join: one details call per sheet, projected to the credit line
rijks-mcp details --stdin --fields objectNumber,creditLine < waller-marked.txt > waller-credit.jsonl

# 3. who each stamped sheet actually came from
jq -r '.creditLine // "" |
  if   test("Waller-?Fonds|Waller Fund")                          then "Waller Fund purchase (post-1934)"
  elif test("Legaat|Bequest")                                      then "Waller bequest (1934)"
  elif test("Schenking van de heer F.G. Waller|Gift of F.G. Waller") then "Waller gift (lifetime)"
  elif . == ""                                                     then "no credit line"
  else "other donor" end' waller-credit.jsonl | sort | uniq -c | sort -nr
```

```
13278 Waller Fund purchase (post-1934)
 2980 Waller bequest (1934)
 2442 Waller gift (lifetime)
 1078 no credit line
  222 other donor
```

Only about a quarter of the stamped sheets came from Waller himself, as his 1934 bequest or as gifts made in his lifetime. Two-thirds were bought by the Waller Fund after his death. The Rijksprentenkabinet applied his stamp to those purchases too, so Lugt 2760 marks everything that entered through Waller's name, not only what he owned. The sheets that carry the stamp have no parsed provenance, and the works whose provenance names Waller do not carry the stamp (`rijks-mcp provenance --party Waller` paged to 124 artworks, then `comm -12` against `waller-marked.txt`). To recover his personal collection, the mark has to be read together with the credit line.

The CLI uses the same `callTool` and returns the same rows the AI assistant sees; what the shell adds is scale and set operations: paging a 20,000-row result, running a details call for every row, and joining two result sets by object number. Two caveats: `search_inscriptions` parses at most 20,000 candidates (`candidatesCapped: true` on the first page), so the tally covers about 60 percent of the marked sheets, in index order; and `--fields` projects top-level keys only, so nested values are unpacked in `jq`.

---

## Using the CLI from an agent

- **Prefer `--http` against a warm server.** It removes the per-call cold-start cost; the stdio
  fallback is for zero-config one-offs.
- **Bootstrap with `tools --compact`** (the compact manifest; fall back to `tools --json` only when
  you need full input/output schemas), then `<verb> --help` for the exact flags — all come from the
  live schema, so they never drift from the server.
- **Project aggressively with `--fields`.** Repeated JSON keys across many rows are pure token
  waste; ask for only what you need.
- **Never silently truncate.** The stderr summary always states `N shown … of M` plus the exact
  next-page flag (`--offset` or `--resumption-token`).
- **Branch on exit codes**: `0` ok, `1` tool/connection error (prose hint on stderr), `2` usage error.
- **Dry-run with `--show-call`** to verify the resolved `{tool, arguments}` before spending a call.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Connection failed … run npm run build …` | stdio path needs a built `dist/` and the DBs in `data/`. Build first, or use `--http <url>`. |
| Exit 2 with `--x is not a flag for "<verb>"` | Typo or wrong command; the message suggests the nearest flag and lists the real ones. Check `<verb> --help`. |
| `Unknown command … (viewer/stateful tool — not available over the CLI)` | The viewer tools aren't exposed over the CLI by design. |
| First `semantic`/`similar`/`list-sets` call is slow | Expected on either transport — those build lazily on first use (~8–9 s). An `--http` server avoids it only once it has already served one such call. |
| No `structuredContent` over `--http` | The target server has `STRUCTURED_CONTENT=false`. The CLI falls back to printing the text channel; re-enable structured output on the server for JSON. |

---

## See also

- [Technical guide](technical-guide.md) — local setup, HTTP deployment, configuration, architecture.
- [Tool parameter reference](mcp-tool-parameters.md) — full per-tool parameter docs (the source of
  truth the CLI's schema-derived help mirrors).
