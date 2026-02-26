# rijksmuseum-mcp+

### Overview

Note: This README is an **incomplete draft**.

**rijksmuseum-mcp+** lets you explore the Rijksmuseum's artworks through natural conversation with an AI assistant. To do this, it creates a [bridge](https://www.anthropic.com/news/model-context-protocol) between the chat environment and the museum's [curated and interconnected open-access metadata](https://data.rijksmuseum.nl). 

Explore artworks by [artist, material, technique, date, depicted person or place, or iconographic subject] and combine these queries with research on the [curatorial wall texts, provenance histories, inscriptions, or iconclass categories]. Besides structural queries, you can also search the collection metadata [semantically], see artworks inline in your chat session in an [interactive image viewer], and carry out [geospatial searches]. 

> This project was inspired by [@r-huijts/rijksmuseum-mcp](https://github.com/r-huijts/rijksmuseum-mcp), the original Rijksmuseum MCP server based on the museum's now superseded REST API. 

**rijksmuseum-mcp+** was developed at the [Research and Infrastructure Support](https://rise.unibas.ch/en/) (RISE) group at the University of Basel and builds on ongoing work on [benchmarking](https://github.com/RISE-UNIBAS/humanities_data_benchmark) and [optimizing](https://github.com/kintopp/dspy-rise-humbench) humanities research tasks. I am particularly interested in exploring the [technical] and [research] possibilities and challenges posed by interlinking (un)structured data, agentic LLMs, and human users for art historical research. If you're interested in collaborating on these questions, please [get in touch]!

## Quick Start

The easiest way to get started is with [Claude Desktop](https://claude.com/download) or [claude.ai](https://claude.ai) by adding a custom 'Connector' to Claude using the URL below. Note that this  currently requires a paid [subscription](https://claude.com/pricing) from Anthropic. 
```
https://rijksmuseum-mcp-plus-production.up.railway.app/mcp
```
Goto Settings → Connectors → Add custom connector → paste the URL above. See Anthropic's [instructions](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp#h_3d1a65aded) for more details. 

Technically speaking, rijksmuseum-mcp+ is a [Model Context Protocol](https://modelcontextprotocol.io/docs/getting-started/intro) or MCP server. It is  compatible with browser chatbots that can be used for free without a subscription, such as Mistral's [LeChat](https://chat.mistral.ai/chat), open-source applications such as [Jan.ai](https://jan.ai) that are able to make use of local LLM models, as well as agentic coding agents such as [Claude Code](https://github.com/anthropics/claude-code) or [OpenAI Codex](https://openai.com/codex/). Currently, OpenAI's ChatGPT only offers limited  support for MCP servers in 'developer' mode. Google has announced support for Gemini but has not indicated when this will be ready.

For most users, [Claude Desktop](https://claude.com/download) or [claude.ai](https://claude.ai) will continue to be the best choice due to its excellent support of the relevant MCP standard and its tight integration with Anthropic's large language models. For best results, I recommend using rijksmuseum-mcp+ with an Anthropic 'Pro' subscription and the current [Claude Sonnet] model with 'extended thinking' turned on. 

rijksmuseum-mcp+ can also be used as a local MCP server with local copies of its metadata and embedding databases. Please see the [technical notes] for details.

### Sample Questions

After you've added the rijksmuseum-mcp+ 'connector' (aka custom MCP server) to your AI system, you can ask it questions about the Rijksmuseum's collections in natural language:

"What artworks evoke vanitas and mortality?"  
"Show me artworks depicting places near the Oude Kerk in Amsterdam"  
"What works have the iconclass code for fabulous animals?"  
"Which artworks have a provenance linked to Napoleon?"  
"What are the 'top ten' works in the Rijksmuseum?"  
"Are there any prints made after paintings by other artists?"  
"I'm looking for artworks with inscriptions mentioning 'luctor et emergo'"  
"Show me sculptures in the collection by artists born in Leiden"  
"Which paintings are wider than 3 meters?"  

### Tips and Caveats

The AI assistant handles search strategy automatically — choosing the right tool, translating between languages, trying alternative phrasings on empty results, and combining filters. The tips below describe things it cannot always compensate for: data coverage gaps, structural limitations of the underlying collection metadata, and cases where how you frame your question affects which results you get.

#### Tips

**Say what you are actually looking for, not how to find it.** The assistant generally does better when given a research question than a list of parameters. "What prints were made after paintings by Rembrandt?" works better than "search for prints with technique etching by Rembrandt", because the first framing lets the assistant choose the right combination of tools and strategies.

**For broad queries, add a second constraint.** Searches across very broad categories — all paintings, all works on paper, all portraits — can match tens of thousands of records. The results are not ranked by importance and only a sample is returned (see 'Known Limitations' below). Combining with a date range, production place, or second subject term makes the results both faster and more meaningful.

**Specify "paintings" when that is what you want, especially for concept searches.** Paintings are underrepresented in concept-based (semantic) search results relative to prints and drawings, because those have denser subject tagging in the Rijksmuseum's catalogue. Saying "paintings showing X" rather than just "artworks showing X" helps the assistant apply the right corrections.

**Try a concept search when structured filters return nothing useful.** If searching by subject, Iconclass, or description doesn't find what you're looking for, asking the assistant to try a concept search (semantic search) can find artworks by meaning rather than exact vocabulary terms. This is especially useful for atmospheric or thematic queries like "sense of loneliness" or "cultural exchange." The assistant can also search Iconclass itself by concept — finding the right notation code by meaning rather than exact keyword — and then use that notation for precise structured search. This two-step path avoids the painting underrepresentation that affects direct concept search.

---

#### Known Limitations

**Structured search results are not ranked by relevance.** When filtering by subject, material, place, technique, or other structured fields, results come back in internal catalogue order — not by quality, importance, or closeness to the query. For a large result set, the first page is essentially an arbitrary slice of the matching artworks, not a curated selection. Concept-based (semantic) searches are the exception: those results are ranked by similarity to your query.

**Result sets are capped and only partially paginated.** Each search returns up to 25 results by default (up to 100 on request). For title and creator searches, the assistant can request additional pages beyond the first 100. For searches by subject, material, place, technique, and other structured filters, there is a hard cap of 100 results with no way to continue beyond them. When a query matches thousands of artworks, only a small, non-representative sample is returned. Adding more specific filters is the best way to get meaningful results from large collections.

**Text coverage varies by field.** About 61% of records include a cataloguer's description (in Dutch). Curatorial wall texts (in English) cover only about 14,000 artworks — mostly highlights and recent acquisitions. Searches by description, inscription, provenance, or narrative only cover the portion of the collection where that text exists.

**Geolocation coverage is partial.** About 64% of named production places have been geocoded. Proximity searches ("artworks produced near Delft") will miss artworks from places that haven't been geocoded. Where coordinates exist, they typically point to the nearest town or region rather than a specific workshop address.

**Iconclass subject classification can be counterintuitive.** The Iconclass system assigns subjects to specific branches of a strict hierarchy that does not always match everyday expectations. However, the assistant can search Iconclass by concept as well as by keyword — describing what you're looking for in plain language (e.g. "domestic animals" or "religious suffering") will often find the right notation even when the exact vocabulary term is unknown. Once the right notation is found, it can be used for precise structured search across the full collection.

**The collection data is predominantly in Dutch.** Titles and subject tags are available in Dutch for virtually all records; English is available for roughly a third. The assistant will try both languages automatically, but searches for specialist terminology, historical place names, or older material may miss records that are catalogued only in Dutch.

**Not all artworks have images.** Coverage is good for major works but incomplete for the full collection. The assistant will report when an image is unavailable.

Note: This README is an **incomplete draft**.

### Authors

[Arno Bosse](https://orcid.org/0000-0003-3681-1289) — [RISE](https://rise.unibas.ch/), University of Basel with [Claude Code](https://claude.com/product/claude-code), Anthropic.

### Image and Data Credits

<add software license>

Collection data and images are provided by the **[Rijksmuseum, Amsterdam](https://www.rijksmuseum.nl/)** via their [Linked Open Data APIs](https://data.rijksmuseum.nl/).

**Licensing:** Information and data that are no longer (or never were) protected by copyright carry the **Public Domain Mark** and/or **[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)**. Where the Rijksmuseum holds copyright, it generally waives its rights under CC0 1.0; in cases where it does exercise copyright, materials are made available under **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**. Materials under third-party copyright without express permission are not made available as open data. Individual licence designations appear on the [collection website](https://www.rijksmuseum.nl/en/rijksstudio).

**Attribution:** The Rijksmuseum considers it good practice to provide attribution and/or source citation via a credit line and data citation, regardless of the licence applied.

Please see the Rijksmuseum's [information and data policy](https://data.rijksmuseum.nl/policy/information-and-data-policy) for the full terms.

### License

This project is licensed under the [MIT License](LICENSE).
