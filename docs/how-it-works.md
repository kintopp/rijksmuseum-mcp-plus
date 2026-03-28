### How it works

When you submit your question, the AI assistant decides which combination of [tools] provided by rijksmuseum-mcp+ will best answer it from the museum's [metadata]. Most queries go directly to a [vocabulary] database built from a periodic harvest of the museum's collection records, while concept-based queries are routed through precomputed embeddings for semantic similarity search. The results from these queries come back as structured data, which the AI interprets, contextualises, and presents in natural language, where requested alongside an artwork displayed in an interactive deep-zoom image viewer. Crucially, at each step, the AI can combine this retrieved data with its own background knowledge — about artists, periods, iconographic traditions, and historical context — to go beyond what the museum's metadata alone would tell you.

rijksmuseum-mcp+ draws on three different data sources: a public API to the collections provided by the Rijksmuseum, its own databases of metadata harvested from the museum's Linked Open Data and OAI-PMH interfaces, and public Iconclass data. This means the AI assistant often needs to route queries through multiple tools and data sources to answer a single question (the so-called 'agentic loop'). Because rijksmuseum-mcp+ maintains its own copy of Rijksmuseum and IconClass metadata , it can store, enrich, and organise this in ways that aid research on the collections. For example:

- indexing curated metadata not exposed through the museum's search interface
- generating embeddings semantic search by meaning and concept
- geocoding toponyms with existing place identifiers for proximity and region-based search
- parsing provenance texts into structured ownership chains with events, parties, prices, and dates
- comparing artworks across multiple modalities of similarity

In this way, rijksmuseum-mcp+ trades the conceptual simplicity of a traditional search interface for the more powerful exploration modalities made possible through the mediation of an AI assistant.
