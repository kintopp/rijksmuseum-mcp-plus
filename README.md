# rijksmuseum-mcp+

[![MCP Protocol](https://img.shields.io/badge/MCP_Protocol-2025--11--25-blue?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIzIi8+PC9zdmc+)](https://modelcontextprotocol.io/specification/2025-11-25)
[![MCP Apps](https://img.shields.io/badge/MCP_Apps-v1.1.2-teal)](https://github.com/modelcontextprotocol/ext-apps)

## Overview

**rijksmuseum-mcp+** lets you explore the Rijksmuseum's artwork collections through natural conversation with an AI assistant. It does this by creating a [bridge](https://www.anthropic.com/news/model-context-protocol) between the AI system's chat environment and the museum's [open-access, curated metadata](https://data.rijksmuseum.nl). 

> This project was inspired by [@r-huijts/rijksmuseum-mcp](https://github.com/r-huijts/rijksmuseum-mcp), the original Rijksmuseum MCP server based on the museum's now superseded REST API. 

The tool was developed as a technology demo by the [Research and Infrastructure Support](https://rise.unibas.ch/en/) (RISE) group at the University of Basel and complements our ongoing work on [benchmarking](https://github.com/RISE-UNIBAS/humanities_data_benchmark) and [optimizing](https://github.com/kintopp/dspy-rise-humbench) humanities research tasks carried out by large language models (LLMs). We are particularly interested in exploring the [research opportunities](docs/research-scenarios.md) and technical challenges posed by retrieving and analysing structured data with LLMs. If you are an interested in collaborating with us in this area, please [get in touch](mailto:rise@unibas.ch).

## Quick Start

The best way to get started is with [Claude Desktop](https://claude.com/download) or [claude.ai](https://claude.ai) by adding rijksmuseum-mcp+ as a custom 'Connector' to Claude using the URL below. This currently requires a paid ('Pro') or higher [subscription](https://claude.com/pricing) from Anthropic.
```
https://rijksmuseum-mcp-plus-production.up.railway.app/mcp
```
Goto _Settings_ → _Connectors_ → _Add custom connector_ → Name it as you like and paste the URL into the _Remote MCP Server URL_ field. You can ignore the Authentication section. Once the connector is configured, optionally set the permissions for its tools (e.g. 'Always allow'). See Anthropic's [instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) for more details.

Technically speaking, rijksmuseum-mcp+ is based on the open [Model Context Protocol](https://modelcontextprotocol.io/docs/getting-started/intro) (MCP) standard. As such, it also works with other generative large language models (LLMs) in browser based chatbots and applications which support the MCP standard, including those LLMs which can be used **without a paid subscription**. However, to date (April, 2026) none beside [Claude Desktop](https://claude.com/download) or [claude.ai](https://claude.ai) support viewing and interacting with images in the chat timeline. For more details, please see the [Choosing an AI System] section below.

## Sample Queries

After you've connected rijksmuseum-mcp+ to your AI system, you can explore the collection in natural language. For example:

- _Show me Avercamp's Winter Landscape with Skaters_
- _What German artworks evoke vanitas and mortality?_
- _List images by female photographers depicting places near the Eiffel Tower_
- _Which artworks have a provenance linked to Emperor Bonaparte?_
- _I'm looking for works with inscriptions mentioning 'luctor et emergo'_
- _Find artworks similar to The Little Street, by Vermeer_
- _Show me sculptures in the collection by artists born in Leiden_
- _Are there paintings in the collection wider than 3 meters?_
- _Which 16th-century paintings are listed as Italian workshop productions?_
- _What types of works does the collection have from Indonesia?_
- _Show me the Roermondse passie and highlight the Betrayal of Judas_

For samples of more complex queries, please see the [research scenarios](docs/research-scenarios.md).

<p align="center"><img src="docs/roermond-passion.jpg" alt="Roermond Passion with highlighted panels" width="500"></p>

## Features

You can explore artworks with the same (with minor exceptions) search filters offered by the Rijksmuseum on their [search collections](https://www.rijksmuseum.nl/en/collection) page. Beyond this, rijksmuseum-mcp+ provides the following additional features:

1. **More searchable metadata** — metadata fields not searchable from the museum's [search portal](https://www.rijksmuseum.nl/en/collection) including `creator` demographics (e.g. `gender`, `profession`, `birthPlace`), `title` variants, bibliography citations for individual artworks, [Iconclass](https://iconclass.org) descriptions, and full-text fields (`description`, `inscription`, `provenance`, `creditLine`, `curatorialNarrative`).

2. **Semantic search** — multilingual, concept/meaning-based explorations across multiple metadata categories. For example, queries like "vanitas symbolism" or "sense of loneliness in domestic interiors" which can't be expressed as structured metadata.

3. **Spatial dimensions** — proximity radius searches on physical locations and size filters for artworks enable various spatial qeuries (e.g. "artworks related to places within 25 km of Leiden", "prints smaller than 10 cm wide"). 

4. **Smart searching and relevance ranking** — morphological stemming to make subject searches more forgiving (e.g. "castle" and "castles"); automatic faceted counts allow the AI assistant to suggest appropriate filters to narrow the search results; textual queries (e.g. on `inscription`) return artworks ranked by relevance instead of catalogue order, while filter-only queries get ranked by their expected importance to users. 

5. **Interactive Image Viewer** — view high-resolution images of artworks inline in your chat discussion (N.B. this feature requires [Claude Desktop](https://claude.com/download) or [claude.ai](https://claude.ai)). Zoom, pan, rotate, flip horizontally or view the image full-screen.

6. **AI image analysis** — the AI assistant can analyse images visually in conjunction with the collection's metadata (e.g. "which iconographic elements of the Annunciation in this image have corresponding entries in Iconclass?").

7. **AI image annotation** - the AI assistant can zoom in and annotate images in the interactive image viewer (e.g. "highlight the biblical scenes depicted in the painting's panels"). Else, draw a rectangle around an area of interest to highlight it for the AI assistant (e.g. 'identify the species of butterfy highlighted in the still-life').

8. **Find similar artworks** - Generates a webpage with a visual comparison of a given artwork showing multiple forms of similarity side by side: Visual, Iconclass, Lineage, Description, Depicted Person, and Depicted Place.

<br>
<p align="center"><img src="docs/genre-analysis.png" alt="Fraction of paintings in each century by subject" width="500"></p>

#### Choosing an AI system

Technically speaking, rijksmuseum-mcp+ works with any chatbot or application supporting the open [Model Context Protocol](https://modelcontextprotocol.io/docs/getting-started/intro) (MCP) and [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) standards. In practice, however, the extent and quality of support of these standards vary widely.

As such, it also works with many other browser based chatbots including those whose large language models (LLMs) can be used **without a paid subscription**. Mistral's [LeChat](https://chat.mistral.ai/chat) is a good example (follow [these instructions](https://help.mistral.ai/en/articles/393572-configuring-a-custom-connector)) of a browser based chatbot with good, basic support of the MCP standard. In addition, many desktop 'LLM client' applications, such as [Jan.ai](https://jan.ai), are also MCP-compatible, and can be used with many many different LLM models. In contrast, OpenAI's ChatGPT still only offers limited, 'developer mode' support for MCP servers, and while Google has announced MCP support for Gemini it has not indicated when this will be ready.

Moreover, none of these alteratives allow you to view and interact with images and visualisations drawn from the responses to queries directly in the chat timeline. For this reason, despite the existence of partially adequate substitutes, are present (April, 2026) the best way to use rijksmuseum-mcp+ remains beside [Claude Desktop](https://claude.com/download) or [claude.ai](https://claude.ai). 

Note to developers: the rijksmuseum-mcp+ server can also be run locally in STDIO mode with local copies of its metadata and embedding databases. Please see the [technical notes](docs/technical-guide.md) for details.

## How it works

`to be added`. Here are references to the available [search parameters](docs/search-parameters.md) and [metadata categories](docs/metadata-categories.md). These [diagrams](docs/mcp-workflow-diagram.md) illustrate the structure and flow of information when using rijksmuseum-mcp+.

## Roadmap

Soon:

- update documentation
- fine-tune query strategies
- fix bugs
- v1.0 release
- paper/presentation

Later:

- create a [SKILL](https://support.claude.com/en/articles/12580051-teach-claude-your-way-of-working-using-skills) file for exploring the collection
- review capabilities of MCP clients besides Anthropic's Claude
- investigate exporting jpg/png from image viewer together with overlays
- add provenance metadata for geolocated places

Maybe:

- investigate adding `attributionQualifier`: "Signed by", "Manner of", "Rejected maker", "Falsification after" 
- investigate separate windows for chat and image viewer
- investigate incorporating historical exhibition data
- investigate integration with other Linked Open Data resources (e.g. [Colonial Collections](https://data.colonialcollections.nl))
- investigate browsing related images in the image viewer
- review places without geolocation data
- investigate support for MCP [elicitations](https://modelcontextprotocol.io/docs/learn/client-concepts#elicitation)

## Authors

[Arno Bosse](https://orcid.org/0000-0003-3681-1289) — [RISE](https://rise.unibas.ch/), University of Basel with [Claude Code](https://claude.com/product/claude-code), Anthropic.

## Citation

If you use rijksmuseum-mcp+ in your research, please cite it as follows. A `CITATION.cff` file is included for use with Zotero, GitHub's "Cite this repository" button, and other reference managers.

**APA (7th ed.)**

> Bosse, A. (2026). *rijksmuseum-mcp+* (Version 0.19.0) [Software]. Research and Infrastructure Support (RISE), University of Basel. https://github.com/kintopp/rijksmuseum-mcp-plus

**BibTeX**
```bibtex
@software{bosse_2026_rijksmuseum_mcp_plus,
  author    = {Bosse, Arno},
  title     = {{rijksmuseum-mcp+}},
  year      = {2026},
  version   = {0.20},
  publisher = {Research and Infrastructure Support (RISE), University of Basel},
  url       = {https://github.com/kintopp/rijksmuseum-mcp-plus},
  orcid     = {0000-0003-3681-1289},
  note      = {Developed with Claude Code (Anthropic, \url{https://www.anthropic.com})}
}
```

## Image and Data Credits

Collection data and images are provided by the **[Rijksmuseum, Amsterdam](https://www.rijksmuseum.nl/)** via their [Linked Open Data APIs](https://data.rijksmuseum.nl/).

**Licensing:** Information and data that are no longer (or never were) protected by copyright carry the **Public Domain Mark** and/or **[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)**. Where the Rijksmuseum holds copyright, it generally waives its rights under CC0 1.0; in cases where it does exercise copyright, materials are made available under **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**. Materials under third-party copyright without express permission are not made available as open data. Individual licence designations appear on the [collection website](https://www.rijksmuseum.nl/en/rijksstudio).

**Attribution:** The Rijksmuseum considers it good practice to provide attribution and/or source citation via a credit line and data citation, regardless of the licence applied.

Please see the Rijksmuseum's [information and data policy](https://data.rijksmuseum.nl/policy/information-and-data-policy) for the full terms.

## License

This project is licensed under the [MIT License](LICENSE).
