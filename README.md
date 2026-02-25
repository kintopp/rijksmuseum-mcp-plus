# rijksmuseum-mcp+

### Overview

Note: This README is currently still an **incomplete draft**.

**rijksmuseum-mcp+** lets you explore the Rijksmuseum's artworks through natural conversation with an AI assistant. To do this, it creates a [bridge](https://www.anthropic.com/news/model-context-protocol) between the chat environment and the museum's extensive holdings of [open-access, curated and interconnected metadata](https://data.rijksmuseum.nl). 

You can survey artworks by [artist, material, technique, date, depicted person or place, or iconographic subject] and combine this with research on the [curatorial wall texts, provenance histories, inscriptions, or iconclass categories]. Besides various kinds of structural queries, you can also search the collection metadata [semantically], see artworks inline in your chat session in an [interactive image viewer], and carry out [geospatial searches]. 

In all this, the AI assistant acts as a guide for a researcher: it converts natural language questions into the right combination of tools and parameters for thse queries, handles variant name spellings and historical terminology, translates between languages, and is able to bring its own background art-historical knowledge to bear to contextualise the results. Finally, because these metadata are made available to the AI system and passed on to you in structured form, it's often possible to use these as a starting point for follow-up tasks like as [visualizations] or quantitative evaluations.

> This project was inspired by [@r-huijts/rijksmuseum-mcp](https://github.com/r-huijts/rijksmuseum-mcp), the original Rijksmuseum MCP server based on the museum's now superseded REST API. 

**rijksmuseum-mcp+** was developed by the [Research and Infrastructure Support](https://rise.unibas.ch/en/) (RISE) team at the University of Basel and builds on ongoing work on [benchmarking](https://github.com/RISE-UNIBAS/humanities_data_benchmark) and [optimizing](https://github.com/kintopp/dspy-rise-humbench) humanities research tasks. In addition, I am particularly interested in exploring the [technical] and [research] possibilities and challenges posed by interlinking and mediating (un)structured data, agentic LLMs, and human users for art historical research. If you're interested in collaborating with us on some of these questions, please [get in touch].

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
"What are the museum's most popular pieces?"  
"Are there any prints made after paintings by other artists?"  
"I'm looking for artworks with inscriptions mentioning 'luctor et emergo'"  
"Which paintings are wider than 300 centimeters?"  
"Show me sculptures in the collection by artists born in Leiden"  
"What was the first work that entered the museum's collection?"  

### Tips and Caveats

to be added



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
