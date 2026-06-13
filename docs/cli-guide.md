# Rijksmuseum MCP+ CLI Guide

A headless command-line interface over the Rijksmuseum MCP server's stateless tools.

The CLI ships as `scripts/cli.mjs`, runnable directly, via `npm run cli`, or as the installed
`rijks-mcp` bin (see [Invocation](#invocation)). It is an MCP **client** — it drives the existing
server rather than reimplementing any search logic. A CLI query therefore returns *exactly* what an
LLM would get from the same tool, which makes it both a power-user/pipeline tool and a debugging /
protocol regression harness. It is JSON-first, designed for shell pipelines and bash-capable agents.

All examples below are real and were run against the production vocabulary database
(~834K artworks). Counts and IDs are from a v0.40 harvest snapshot and may shift after a re-harvest.

---

## Contents

- [Invocation](#invocation)
- [Transports (warm HTTP vs cold stdio)](#transports)
- [Output model](#output-model)
- [Flags & argument conventions](#flags--argument-conventions)
- [Discovery & introspection](#discovery--introspection)
- [Command reference](#command-reference)
- [Pipeline recipes](#pipeline-recipes)
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

**Scope.** The CLI exposes the 11 stateless tools. The four viewer/stateful tools
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

### Cold-start cost (stdio only)

The CLI's stdio transport sets `MCP_SKIP_STARTUP_WARM=1`, so a cold one-shot skips the server's
~13 s eager warm-up. Caches instead build **lazily on first use**:

- Plain vocab queries (`search`, `details`, `stats`, `persons`, `provenance`) → **~1 s**.
- First `semantic` / `similar` call → relocates the ~8 s embeddings warm to that call.
- First `list-sets` / `browse-set` call → builds the curated-sets cache (~9 s) on that call.

Under `--http` against a warm server none of this recurs — which is why HTTP is the better choice
for any repeated/agent use.

---

## Output model

**stdout is the data channel; stderr is the human/diagnostic channel.** This keeps stdout pure and
`jq`-clean.

| What | Goes to |
|---|---|
| Result rows (list tools) | **stdout**, one JSON object per line (JSONL) |
| Single-object results (`details`, `similar`, `inspect` metadata) | **stdout**, one compact JSON object |
| Count + pagination hint + `warnings` | **stderr** |
| Server diagnostics (DB banner, per-tool log line) — *stdio mode only* | **stderr** |

Server diagnostics appear on stderr only in stdio mode (the subprocess inherits stderr). Under
`--http` they stay on the server, so stderr carries just the CLI's own summary line.

### Output flags

| Flag | Effect |
|---|---|
| *(default)* | JSONL for lists, compact JSON for single objects |
| `--json` | Print the entire `structuredContent` payload, pretty-printed (verbatim — no list-splitting, no projection) |
| `--table` | Terse human-readable table (opt-in) |
| `--fields a,b,c` | Project to these top-level keys on every emitted object — the biggest token saver |
| `--quiet` | Suppress the stderr summary line |

```bash
# Default: JSONL, one object per line
$ node scripts/cli.mjs search --creator "Rembrandt van Rijn" --type painting --max 2 --fields objectNumber,title
{"objectNumber":"SK-C-5","title":"The Night Watch Militia Company of District II under the Command of Captain Frans Banninck Cocq"}
{"objectNumber":"SK-C-6","title":"The Sampling Officials of the Amsterdam Drapers’ Guild, Known as ‘The Syndics’"}
# (on stderr)  2 shown (offset 0) of 34; pass --offset 2 for more

# Table for eyeballing
$ node scripts/cli.mjs stats type --topN 5 --fields label,count --table
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
| `2` | Usage error (unknown command, an out-of-scope viewer tool, bad flags) |

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

### The `--max` alias caveat

`--max` (and `-n`) is a convenience alias for `maxResults`, which **most** commands use. Two
commands page differently — using `--max` there is rejected by the strict schema (you'll get an
empty stdout + a tool error on stderr):

| Command | Use this for the result cap |
|---|---|
| `stats` | `--topN <n>` |
| `list-sets` | `--minMembers` / `--maxMembers` (no direct cap) |
| everything else | `--max` / `--maxResults` |

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
`positional`, `result` shape, optional `page` mode, and `args` as name→type, with a trailing `!`
marking required args). It's the CLI equivalent of MCP `tools/list` but ~30× smaller than
`tools --json`, which dumps every tool's full input *and* output JSON Schema — reserve that for deep
introspection. Both derive from the live schema, so neither drifts from the server.

```bash
$ node scripts/cli.mjs tools --compact | jq '.[] | select(.tool=="find_similar")'
{
  "verb": "similar",
  "tool": "find_similar",
  "positional": "objectNumber",
  "result": "single",
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
| `persons` | `search_persons` | `name` | `--max` | `persons` | offset |
| `provenance` | `search_provenance` | `party` | `--max` | `results` | offset |
| `details` | `get_artwork_details` | `objectNumber` | — (single) | — | — |
| `stats` | `collection_stats` | `dimension` | `--topN` | `entries` | offset |
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
list via `search --help` (32 filters: title, creator, subject, type, material, technique, dates,
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

Meaning/concept search (natural language). Ranked by similarity; returns up to 15 (max 50). Same
pre-filters as `search` (`--type`, `--material`, `--creator`, `--iconclass`, …).

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

Search the ~290K person + ~12K group authority records by name, gender, birth/death year/place, or
profession. Returns `vocabId`s to feed into `search --creator <vocabId>` (works *by*) or
`search --aboutActor <vocabId>` (works *depicting*).

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

Output keys: `totalArtworks`, `results`, plus `periods`/`facets`/`warnings` depending on layer.
Each result: `objectNumber`, `title`, `creator`, `date`, `url`, `eventCount`, `matchedEventCount`,
`events`.

---

### `details` → `get_artwork_details`

Full metadata for one object (34 categories). Single-object output. Pair with `--fields` to keep it
small.

```bash
$ node scripts/cli.mjs details SK-C-5 --fields objectNumber,title,creator,date,type
{"objectNumber":"SK-C-5","title":"The Night Watch ...","creator":"Rembrandt van Rijn","date":"1642","type":"painting"}

# Full record, pretty
node scripts/cli.mjs details SK-C-5 --json | jq '.provenanceChain'
```

Note the field rename in recent versions: physical dimensions are under `physicalDimensions` (was
`dimensionStatement`).

---

### `stats` → `collection_stats`

Aggregate counts/distributions across a dimension. **Cap with `--topN`, not `--max`.** Artwork and
provenance dimensions; filters compose (`--type`, `--creator`, `--productionPlace`, …).

```bash
$ node scripts/cli.mjs stats type --topN 5 --fields label,count --table
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
$ node scripts/cli.mjs browse-set 2619 --max 2 --fields objectNumber,title,extentText
{"objectNumber":"...","title":"...","extentText":"..."}
...
# stderr: 2 shown of 139; pass --resumption-token MjYxOQky for more

node scripts/cli.mjs browse-set 2619 --resumption-token MjYxOQky --max 2
```

Output keys: `records`, `totalInSet`, `resumptionToken`. Each record: `objectNumber`, `title`,
`creator`, `date`, `extentText` (was `dimensions`), `datestamp`, `hasImage`, `imageUrl`,
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
{"identifier":"https://id.rijksmuseum.nl/2001","datestamp":"2026-01-28T07:15:24Z"}
...
# stderr: 3 shown of 841520; pass --resumption-token <uuid> for more

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

Metadata keys: `objectNumber`, `region`, `requestedSize`, `nativeWidth`, `nativeHeight`,
`cropPixelWidth`, `cropPixelHeight`, `cropRegion`, `rotation`, `quality`, `fetchTimeMs`.

---

## Pipeline recipes

Because lists are JSONL on stdout, the usual Unix tools compose:

```bash
# Top 10 object types as a count table
node scripts/cli.mjs stats type --topN 10 --fields label,count | jq -r '[.label, .count] | @tsv'

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
| Empty stdout + an error on stderr | The strict schema rejected a flag (e.g. `--max` on `stats` — use `--topN`; or an unknown flag). Check `<verb> --help`. |
| `Unknown command … (viewer/stateful tool — not available over the CLI)` | The viewer tools aren't exposed over the CLI by design. |
| First `semantic`/`similar`/`list-sets` call is slow over stdio | Expected — those caches build lazily on first use (~8–9 s). Use a warm `--http` server to avoid it. |
| No `structuredContent` over `--http` | The target server has `STRUCTURED_CONTENT=false`. The CLI falls back to printing the text channel; re-enable structured output on the server for JSON. |

---

## See also

- [Technical guide](technical-guide.md) — local setup, HTTP deployment, configuration, architecture.
- [Tool parameter reference](mcp-tool-parameters.md) — full per-tool parameter docs (the source of
  truth the CLI's schema-derived help mirrors).
