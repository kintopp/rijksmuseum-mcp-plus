## Token and Cost Benchmarks

### Overview

Every question you put to Claude is paid for in *tokens*: the text the model reads (your question, its instructions, and everything its tools send back) and the text it writes. Connecting an MCP server adds a fixed entry cost, because Claude has to read the descriptions of all its tools before it can use any of them. But it can potentially also make research cheaper, because one precise database query can replace many rounds of searching the web, reading pages and guessing.

In these benchmarks we ask Claude the same set of research questions three ways: with rijksmuseum-mcp+ connected, with rijksmuseum-mcp+ plus its [research skill](../README.md#research-skill), and with no MCP server at all, only ordinary web search. Each answer is checked for a known fact (an object number, a name, a date), so a run that is cheap but wrong doesn't count as a win.

### What is measured

Each question runs in up to three set-ups, called *arms*:

| Arm | What Claude has | What it shows |
|---|---|---|
| **mcp** | rijksmuseum-mcp+ only | The cost of answering with the collection database |
| **mcp+skill** | rijksmuseum-mcp+ and the research skill | Whether the skill's guidance saves steps on harder questions |
| **baseline** | web search and web fetch only, no server | What Claude would do without the server, for comparison |

Without a baseline you can see what the server costs, but not whether it is worth it using. With it you can see, for example, that the server is more expensive than the baseline on a question as famous as *"what is the object number of Vermeer's Milkmaid?"* (which Claude can answer from memory), yet far cheaper and more accurate on a question that only the collection data can answer, such as ranking the collection's most prolific women artists.

For every run the benchmark reports:

- **tokens**: everything the model read and wrote across the whole conversation. Most of this is re-reading earlier context, which is cached and billed at a fraction of the normal price, so tokens alone overstate the real cost.
- **cost**: what the run would cost at the standard [Claude API prices](https://www.anthropic.com/pricing), including those cache discounts. This is the better figure for comparing arms. (Runs made under a Claude subscription aren't billed per token; the figure shows what the same work would cost through the API.)
- **turns** and **tool calls**: how many steps Claude took to reach its answer.
- **time**: wall-clock seconds.
- **expect**: whether the answer contained the known fact(s) for that question.

### Running the benchmark

The benchmark drives [Claude Code](https://claude.com/claude-code) in headless mode (`claude -p`), so you need Claude Code installed and signed in, either with a Claude subscription or an API key. **Every run is a real Claude session**: it counts against your subscription's usage limits or is billed to your API account. The full set (7 questions × 3 arms × 3 runs) is 63 sessions.

```bash
node scripts/bench/mcp-bench.mjs                        # mcp + baseline, Sonnet, 1 run each
node scripts/bench/mcp-bench.mjs --skill --runs 3       # add the mcp+skill arm, 3 runs each
node scripts/bench/mcp-bench.mjs --model opus           # or --model both
node scripts/bench/mcp-bench.mjs --only women-artists,wartime-provenance
node scripts/bench/mcp-bench.mjs --local                # test a local build over stdio
node scripts/bench/mcp-bench.mjs --dry-run              # print the sessions without running them
```

| Flag | Default | Meaning |
|---|---|---|
| `--model sonnet\|opus\|both` | `sonnet` | Uses the latest Sonnet and/or Opus model |
| `--effort <level>` | Sonnet `high`, Opus `medium` | Reasoning effort (defaults match each model's API default) |
| `--runs N` | `1` | Repetitions per question and arm. Use 3 or more before comparing results |
| `--arms mcp,baseline,mcp+skill` | `mcp,baseline` | Which arms to run; `--skill` is shorthand for adding `mcp+skill` |
| `--only id,id` | all | Restrict to questions by id (see below) |
| `--server <url>` / `--local` | public server | Target another `/mcp` endpoint, or spawn `dist/index.js` over stdio |
| `--concurrency N` | `1` | Sessions run in parallel |
| `--budget <usd>` | `3` | Per-session spending cap (at API list price) |
| `--cold` | off | Skip the cache warm-up (see below) |

**Cache warm-up.** Before the measured sessions, the benchmark sends one trivial question per arm ("Reply with just: ok"). This loads that arm's instructions and tool descriptions into Claude's cache, the way an earlier question would in normal use. Every measured session then starts from the same state, so the comparison reflects how each arm answers rather than which session happened to run first. The warm-up's cost is reported on its own line as the **entry cost**: what the first question of a session pays on top of the per-question figures.

Each session runs in an empty scratch directory with the user's own settings, hooks, plugins and MCP servers switched off, so the arms differ only in the tools they're given. Output goes to `scripts/bench/results/<timestamp>/`: one JSON file per session (the full result, including the answer text and which tools were called) and a `summary.csv`. The console shows one line per session followed by per-question averages and arm-to-arm ratios:

```
  women-artists / mcp / sonnet / run 1 ... 67,740 tokens, $0.025, 2 turns, 1 tool calls, 9s, expect ok
  women-artists / baseline / sonnet / run 1 ... 237,540 tokens, $0.298, 42 turns, 41 tool calls, 83s, expect FAIL (missing /Pennink/, /Vos/)
```

### The questions

The questions live in [`scripts/bench/prompts.json`](../scripts/bench/prompts.json). They range from single facts to open research tasks; the complex ones are taken from the [research scenarios](research-scenarios.md).

| Id | Tier | Question (abridged) | Answer check |
|---|---|---|---|
| `milkmaid-id` | simple | Object number of Vermeer's *The Milkmaid* | `SK-A-2344` |
| `nightwatch-dims` | simple | Recorded dimensions of *The Night Watch* | 379.5 × 453.5 cm |
| `avercamp-skaters` | medium | Avercamp's winter landscape with skaters: object number and Dutch title | `SK-A-1718` |
| `women-artists` | medium | The three most prolific women artists in the collection | Bieruma Oosting, Pennink-Boelen, Vos |
| `flinck-examinations` | medium | Technical examination record of Flinck's *Isaac Blessing Jacob* ([scenario 34](research-scenarios.md#34-the-technical-biography-of-a-painting)) | 1930, infrared, X-ray |
| `wartime-provenance` | complex | Works confiscated or restituted 1933–1945, with gaps ([scenario 23](research-scenarios.md#23-wartime-transfers-and-provenance-gaps)) | confiscation, restitution, a matching object number |
| `rembrandt-acquisition` | complex | How the Rembrandt collection was acquired ([scenario 8](research-scenarios.md#8-credit-lines-and-acquisition-context)) | bequest, purchase, Rembrandt object numbers |

An answer check is a simple text match, which is enough to tell whether the right facts came back.

### Results

**2026-10-04 · Claude Sonnet 5.5 (effort `high`) · server v0.94.0 · skill 0.95 · 3 runs per question and arm · no cache warm-up (`--cold`)**

Average cost per question at API list price, with the average number of steps (turns) in brackets. *Passed* counts the runs whose answer contained the expected facts. The baseline column is from the 2026-10-03 run; it doesn't use the server or the skill, so it was not repeated.

| Question | Tier | mcp | mcp+skill | baseline | mcp vs baseline |
|---|---|---|---|---|---|
| `milkmaid-id` | simple | $0.075 (3) · 3/3 \* | $0.072 (3) · 3/3 \* | $0.005 (1) · 3/3 | 15× more \* |
| `nightwatch-dims` | simple | $0.039 (2) · 3/3 | $0.044 (2) · 3/3 | $0.071 (3) · 3/3 | 0.55× |
| `avercamp-skaters` | medium | $0.024 (2) · 3/3 | $0.025 (2) · 3/3 | $0.070 (2) · 3/3 | 0.34× |
| `women-artists` | medium | $0.022 (2) · 3/3 | $0.026 (2) · 3/3 | $0.550 (61) · **0/3** | 0.04× |
| `flinck-examinations` | medium | $0.035 (2) · 3/3 | $0.039 (2) · 3/3 | $0.158 (5) · 3/3 | 0.22× |
| `wartime-provenance` | complex | $0.204 (13) · 3/3 | $0.242 (16) · 3/3 | $1.520 (60) · **1/3** | 0.13× |
| `rembrandt-acquisition` | complex | $0.593 (36) · 3/3 | $0.616 (36) · 3/3 | $0.800 (36) · 3/3 | 0.74× |

\* `milkmaid-id` runs first, so with `--cold` its first run in each arm pays the entry cost (about $0.15). Runs 2 and 3 averaged $0.036 (mcp) and $0.029 (mcp+skill), roughly 6–7× the baseline.

The 42 server sessions came to $6.17 at the API list price; with the 21 baseline sessions the whole set is about $15.70. What the numbers show:

- **The server is cheaper on everything except the most famous facts.** Claude answers *The Milkmaid*'s object number from memory, so the baseline costs half a cent; with the server connected, reading its tool descriptions alone costs more than that. On every other question the server costs between 4% and 74% of the baseline.
- **It is also more accurate.** All 42 runs with the server passed. The baseline failed every run of the women-artists question (the ranking exists only in the collection's person index; web search can't reconstruct it) and two of three runs of the wartime provenance question, after an average of 60 steps and over six minutes.
- **The slimmer skill costs less when it is used.** Claude again loaded the skill only on the two complex questions. Its body is now about 2,900 tokens instead of 18,400, and the extra cost over the server alone on the wartime provenance question fell from 43% to 19%; on the Rembrandt question it stayed at about 4%. It didn't save steps on either question. On the simpler questions the extra 2–17% is the overhead described under *Caveats*. The skill's value lies in the quality of its answers to open research questions, which these text checks don't capture.
- **Open-ended research remains expensive.** The Rembrandt acquisition question took about 36 steps with or without the server, because answering it means going through many individual works. The server still made it cheaper and faster (74 s against 132 s), but this is the kind of question where the tools themselves have the most room to improve.

### Server footprint

The benchmark above measures complete conversations, so its numbers include Claude Code's own instructions and habits. A second, much simpler measurement looks only at what the server itself adds, which is the same whichever app you use:

- **the tool catalogue**: how many tokens the full tool descriptions take, and how many the one-line summaries take on their own (apps such as claude.ai show the model only those summaries at first and load a full description when the tool is needed);
- **response sizes**: how much text typical tool calls send back to the model;
- **the research skill**: its always-visible description, the main body loaded when the skill is used, and each reference file.

No model is involved, so it costs nothing to run. With an Anthropic API key in `ANTHROPIC_API_KEY` (or in the project's `.env`) the counts come from Anthropic's free token-counting endpoint; without one, the script prints an estimate.

```bash
node scripts/bench/footprint.mjs            # public server
node scripts/bench/footprint.mjs --local    # local build over stdio
node scripts/bench/footprint.mjs --json     # machine-readable output
```

**2026-10-04 · server v0.94.0 · skill 0.95 · Claude Sonnet 5.5 token counter**

| Part | Tokens | When a model reads it |
|---|---|---|
| Full tool descriptions (17 tools) | 30,630 | Up front, in apps that load all tools at once (such as Claude Code) |
| Tool names and one-line summaries | 487 | Up front, in apps that load tools on demand (such as claude.ai) |
| Largest single tool (`search_artwork`) | 8,766 | When the tool is first needed, in on-demand apps |
| Typical tool response | 240–3,223 | After each call (an object's full details ≈ 1,900–3,200; a semantic search ≈ 2,800) |
| Skill description | 287 | Always, once the skill is installed |
| Skill body | 2,860 | When Claude decides the skill is relevant |
| Skill reference files | 792–7,103 each | Only when a reference is opened |

The full tool descriptions account for almost all of the entry cost seen in the benchmark. The skill body is now small; most of the mcp+skill arm's remaining overhead is Claude Code's listing of its built-in skills (see *Caveats*). Individual responses, by contrast, are small; the expensive conversations are the ones that need many calls.

### Caveats

- **Per-question costs assume a warm cache.** Claude caches what it has already read for up to an hour. The cache warm-up makes every measured session start warm, so the per-question figures describe an ongoing session; the first question of a new session also pays the entry cost. Running two benchmarks at the same time lets them share a cache, which makes the second one's entry cost look too low. With `--cold`, whichever session runs first in each arm pays the entry cost instead, and single runs can differ several-fold; compare averages over three or more runs.
- **The baseline knows famous facts.** For well-known works Claude may answer from memory without searching at all, so the baseline wins the simplest questions. This is a real effect, not a flaw in the benchmark, but it means the server's value shows mainly in the medium and complex questions.
- **The skill arm carries extra overhead.** Claude Code can't load our skill without also listing its own built-in skills, which adds a few thousand (mostly cached) tokens per step to the mcp+skill arm only. The skill also loads only when Claude decides it is relevant, which in practice means the harder research questions.
- **This measures Claude Code, not claude.ai.** The sessions connect to the server directly. Chat apps such as claude.ai or Claude Desktop add their own instructions, and claude.ai loads full tool descriptions only when they're needed, so its entry cost is likely lower. Absolute numbers there will differ; the comparison between arms should hold. The [server footprint](#server-footprint) gives the app-independent part.
- **Results are a snapshot.** Model releases, tool-description changes and data updates all move the numbers, which is why each results table is dated and names the model and server version.
