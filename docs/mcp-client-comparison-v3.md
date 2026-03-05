# AI assistants as MCP clients: a comprehensive feature comparison

*Research current as of March 2026*

---

The Rijksmuseum MCP+ server (`kintopp/rijksmuseum-mcp-plus`) is an enhanced TypeScript/Node.js MCP server developed at the Research and Infrastructure Support (RISE) unit, University of Basel. It exposes **14 tools** covering semantic and full-text search, Iconclass vocabulary lookup, IIIF image inspection with region cropping, interactive deep-zoom viewer navigation with labelled overlays, bibliography retrieval, Linked Art URI resolution, curated set browsing via OAI-PMH, and proximity/geo search across 831,000+ artworks.

### Transport modes

The server supports two deployment modes:

| Mode | Details |
|---|---|
| **Remote HTTP (primary)** | Hosted on Railway: `https://rijksmuseum-mcp-plus-production.up.railway.app/mcp` — configured as a "custom Connector" in any MCP client that supports remote servers. No local setup required. The recommended entry point for most users. |
| **Local STDIO (secondary)** | Run locally with a local copy of the SQLite/FTS5 vocabulary and embedding databases. Requires Node.js 18+, a Rijksmuseum API key passed as an environment variable, and manual `claude_desktop_config.json` setup. For technical users who need offline operation or local data customisation. |

### MCP primitives and authentication

The server exposes **tools only** — it does not implement Resources, Prompts, or Sampling endpoints. The remote Railway instance requires no MCP-level OAuth; the Rijksmuseum API key is baked into the server's runtime environment, so clients simply point to the URL without needing to manage credentials.

### The interactive image viewer

The server's most visually distinctive feature — an inline deep-zoom image viewer with pan, rotate, flip, and annotation capabilities — relies on MCP returning structured content that the client renders as interactive UI. This maps onto Anthropic's Integrations / Desktop Extensions framework and is confirmed to work **in Claude Desktop and claude.ai only**. Other clients receive image URLs and artwork metadata in tool output and can display static images, but the seamless in-conversation viewer is an Anthropic-specific affordance. For art-historical research workflows where close looking at high-resolution images is central, this is a meaningful differentiator.

### Confirmed compatible clients (per the README)

The server's own documentation names the following as confirmed working: **Claude Desktop, claude.ai, Mistral LeChat, Jan.ai, Claude Code, OpenAI Codex**. ChatGPT is described as offering only "limited, developer-mode support". Google Gemini's web interface MCP support is described as announced but not yet shipped.

---

## The MCP protocol: version history and current state

MCP launched in **November 2024** (spec 2024-11-05) with stdio and HTTP/SSE transports. Four major revisions followed:

- **March 2025** (2025-03-26): Introduced **Streamable HTTP** as the successor to the now-deprecated HTTP/SSE transport; added **OAuth 2.1** with mandatory PKCE; formalised tool annotations for describing side effects.
- **June 2025**: Enhanced OAuth by separating MCP servers as Resource Servers in the authorisation model.
- **November 2025** (2025-11-25, the current stable release): Added async **Tasks**, **Client ID Metadata Documents** (a simpler alternative to Dynamic Client Registration), **Enterprise-Managed Authorization** for SSO integration, and an extensions framework. Also introduced sampling-with-tools for full agentic loops.
- **January 2026**: **MCP Apps** launched as an official extension enabling servers to return interactive UI components rendered directly in conversations — supported initially by Claude, ChatGPT, Goose, and VS Code.

In **December 2025**, Anthropic donated MCP to the newly formed **Agentic AI Foundation** under the Linux Foundation, co-founded with Block and OpenAI. Platinum members include AWS, Bloomberg, Cloudflare, Google, and Microsoft — cementing MCP as vendor-neutral infrastructure rather than an Anthropic-proprietary protocol.

---

## MCP client comparison tables

Legend: ✅ fully supported · ⚠️ partial or workaround needed · ❌ not supported · ❓ unknown / undocumented

---

### Table 1 — Anthropic products and major web platforms

| Feature | Claude Desktop | Claude.ai (web) | ChatGPT (web) | Gemini CLI | Gemini (web) | Perplexity (Mac) | Mistral LeChat |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **stdio transport** | ✅ | ❌ N/A | ❌ N/A | ✅ | ❌ N/A | ✅ | ❌ N/A |
| **HTTP/SSE (legacy)** | ✅ | ✅ | ✅ | ✅ | ❌ | ⚠️ | ⚠️ |
| **Streamable HTTP** | ✅ | ✅ | ✅ | ✅ | ❌ | ⚠️ | ✅ |
| **Tools** | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| **Resources** | ✅ ⚠️ some bugs | ✅ | ⚠️ indirect | ❌ | ❌ | ❓ | ❓ |
| **Prompts** | ✅ | ✅ | ❌ | ❌ | ❌ | ❓ | ❓ |
| **Sampling** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **OAuth 2.0 / 2.1** | ✅ | ✅ | ✅ | ✅ | ❌ | ⚠️ planned | ⚠️ |
| **Multi-server** | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| **Remote servers** | ✅ | ✅ Pro+ | ✅ limited | ✅ | ❌ | ⚠️ coming | ✅ |
| **MCP ext-apps / inline UI** | ✅ Desktop Ext. | ✅ Integrations | ⚠️ MCP Apps beta | ❌ | ❌ | ❌ | ❌ |
| **Config UX** | JSON + GUI | GUI (Connectors) | GUI (limited) | JSON / SDK | — | GUI | GUI |
| **Free tier** | ❌ | ❌ | ⚠️ limited | ✅ CLI | ❌ MCP N/A | ⚠️ | ✅ |
| **Rijksmuseum MCP+ (HTTP)** | ✅ + viewer | ✅ + viewer | ⚠️ dev mode | ✅ | ❌ no MCP | ⚠️ partial | ✅ |
| **Rijksmuseum MCP+ (STDIO)** | ✅ | ❌ N/A | ❌ N/A | ✅ | ❌ N/A | ✅ | ❌ N/A |

**Claude Desktop** is the reference MCP implementation and the single most feature-complete client. 

**Claude.ai (web)** supports the full Integrations experience for remote servers (Pro/Team/Enterprise). It cannot spawn local processes, so STDIO-only servers are inaccessible without a remote wrapper.

**ChatGPT** added "developer mode" MCP support as a beta in late 2025. Remote HTTP connections and tool calling work at the API level, but the user-facing UI for managing MCP servers is lacking. The server's own README characterises this as "limited".

**Gemini web** had not shipped consumer-facing MCP support as of the README's writing, despite Google's announcement in March 2025. The **Gemini CLI** and Gemini API SDK support MCP fully, including both transports and OAuth.

**Mistral LeChat** is confirmed in the README as a working free-tier browser client for the remote HTTP endpoint.

---

### Table 2 — IDE and agentic developer tool clients

| Feature | VS Code / Copilot | Cursor | Windsurf | Cline | Continue.dev | Amazon Q Dev | Claude Code |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **stdio** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **HTTP/SSE (legacy)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Streamable HTTP** | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ |
| **Tools** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Resources** | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | ❓ | ⚠️ |
| **Prompts** | ✅ | ⚠️ | ❓ | ✅ | ✅ | ✅ | ⚠️ |
| **Sampling** | ❓ | ❌ | ❌ | ❓ | ❓ | ❌ | ❌ |
| **OAuth 2.0 / 2.1** | ✅ | ✅ | ✅ | ⚠️ env vars | ✅ | ✅ | ✅ |
| **Multi-server** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Remote servers** | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ |
| **Tool count limit** | No hard limit | 40 tools | 100 tools | No limit | No limit | ❓ | No limit |
| **Config UX** | JSON + registry | JSON + marketplace | JSON + marketplace | GUI + JSON | YAML / JSON | GUI + JSON | JSON / flags |
| **Maturity** | ✅ GA Jul '25 | ✅ Production | ✅ Production | ✅ Production | ✅ Production | ✅ Production | ✅ Production |
| **Rijksmuseum MCP+ (HTTP)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Rijksmuseum MCP+ (STDIO)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**VS Code / GitHub Copilot** is the most complete non-Anthropic client. It has the richest feature set outside Claude Desktop.

**Continue.dev** stands out as the most complete open-source third-party client: tools, resources, and prompts, all three transports, OAuth, and the ability to import Claude Desktop JSON config files directly.

**Cursor** offers the most polished developer experience with one-click marketplace installs and deep Composer Agent integration, but its 40-tool limit and partial resource/prompt support place it behind VS Code in raw feature coverage. The Rijksmuseum MCP+'s 14 tools fit comfortably within the limit.

**Claude Code** is confirmed by the README as a working client. As a terminal-based agentic tool, it handles both transport modes and is well-suited to programmatic or batch research tasks against the museum data.

**Windsurf** imposes a 100-tool cap across all connected servers. With 14 tools, the Rijksmuseum MCP+ leaves ample headroom.

---

### Table 3 — Open-source chat and self-hosted clients

| Feature | Open WebUI | AnythingLLM | LibreChat | Jan.ai | Lobe Chat | Msty |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **stdio** | ⚠️ via mcpo proxy | ✅ | ✅ | ✅ | ⚠️ via bridge | ✅ |
| **HTTP/SSE (legacy)** | ⚠️ via mcpo | ✅ | ✅ | ⚠️ | ✅ plugin | ⚠️ deprecated |
| **Streamable HTTP** | ✅ native | ✅ | ✅ | ⚠️ planned | ✅ native | ✅ |
| **WebSocket** | ❌ | ❌ | ✅ unique | ❌ | ❌ | ❌ |
| **Tools** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Resources** | ❌ | ❌ | ❓ | ❌ | ❓ | ❓ |
| **Prompts** | ❌ | ❌ | ❓ | ❌ | ❓ | ❓ |
| **Sampling** | ❌ | ❌ | ❓ | ❓ | ❓ | ❓ |
| **OAuth 2.0 / 2.1** | ✅ 2.1 | ❌ headers only | ✅ full DCR | ⚠️ | ⚠️ headers | ✅ bearer |
| **Multi-server** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Remote servers** | ✅ | ✅ desktop | ✅ | ✅ | ✅ | ✅ |
| **Local model support** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Open source** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ freemium |
| **Self-hostable** | ✅ | ✅ | ✅ | ✅ local | ⚠️ | ❌ |
| **Rijksmuseum MCP+ (HTTP)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Rijksmuseum MCP+ (STDIO)** | ⚠️ needs proxy | ✅ | ✅ | ✅ | ⚠️ needs bridge | ✅ |

**LibreChat** leads among self-hosted web applications: full support for stdio, SSE, Streamable HTTP, and WebSocket (unique among all surveyed clients), enterprise-grade OAuth with Dynamic Client Registration, per-user credential isolation, and deferred tool loading to manage context size. Best choice for institutional deployments.

**Jan.ai** is confirmed in the README as a working client. It supports local model execution (Llama, Mistral, etc.) with full data privacy, making it a natural fit for researchers who cannot or will not send data to cloud APIs.

**Open WebUI** handles Streamable HTTP natively but requires the **mcpo proxy** to bridge stdio servers. For the Rijksmuseum MCP+'s HTTP endpoint, it works out of the box; STDIO mode needs an extra step.

**AnythingLLM** supports stdio directly in its desktop version but remote-only in its cloud version.

**Lobe Chat** uses a plugin architecture that bridges MCP via a local companion process for stdio; the HTTP endpoint is more straightforward.

**Msty** is a proprietary freemium desktop application. It works with both transport modes but is not open source and does not offer self-hosting.

---

## Recommendations by use case

| Goal | Best client(s) |
|---|---|
| Full experience including image viewer | Claude Desktop or claude.ai (Pro/Team) |
| Free-tier browser access | Mistral LeChat |
| Local models / data privacy | Jan.ai |
| Programmatic or batch research tasks | Claude Code, Gemini CLI |
| Self-hosted institutional deployment | LibreChat |
| Developer / agentic coding context | VS Code + Copilot, Cursor |
| Broadest MCP primitive support (non-Anthropic) | VS Code + Copilot, Continue.dev |

---

*Sources: Rijksmuseum MCP+ README and technical guide; MCP specification changelog (2024-11-05 through 2025-11-25); Anthropic Integrations announcement (May 2025); MCP Agentic AI Foundation announcement (December 2025); PulseMCP client registry; official documentation for VS Code, Cursor, Windsurf, LibreChat, Jan.ai, Continue.dev, Cline, Amazon Q, Lobe Chat, Open WebUI, AnythingLLM; OpenAI ChatGPT developer mode help article; Mistral LeChat documentation; awesome-mcp-clients (punkpeye/GitHub).*
