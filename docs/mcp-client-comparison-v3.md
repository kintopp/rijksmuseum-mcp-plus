# MCP clients feature comparison

*Research current as of March 2026*


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
