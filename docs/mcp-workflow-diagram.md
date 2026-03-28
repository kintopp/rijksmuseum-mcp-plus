# MCP Workflow Diagram

How an AI assistant uses rijksmuseum-mcp+ to answer a question about art.

```mermaid
flowchart LR
    User["You"] <-->|conversation| AI["AI Assistant"]

    AI <-->|"MCP tool calls
    (agentic loop)"| Server["rijksmuseum-mcp+
    15 tools"]

    Server --> Search["Search & Discovery
    structured filters,
    semantic search,
    Iconclass lookup,
    collection statistics"]

    Server --> Details["Details & Metadata
    Linked Art resolution,
    bibliography,
    provenance chains,
    similarity comparison"]

    Server --> Images["Image Inspection
    deep-zoom viewer,
    region crops for AI vision,
    overlay annotations"]

    Search --> VocabDB[("Vocab DB
    832K artworks
    194K vocab terms
    13.7M mappings")]
    Search --> EmbeddingsDB[("Embeddings DB
    832K vectors
    semantic search")]
    Search --> IconclassDB[("Iconclass DB
    40K notations")]
    Details --> LinkedArt["Linked Art API
    id.rijksmuseum.nl"]
    Details --> VocabDB
    Images --> IIIF["IIIF Image API
    iiif.micr.io"]
```

**The agentic loop:** the AI assistant doesn't make one call to the MCP server and stop — it chains
tools iteratively, each result informing the next. A single question like
*"show me how Vermeer uses light"* might trigger:

```mermaid
sequenceDiagram
    participant You
    participant AI
    participant MCP as rijksmuseum-mcp+

    You->>AI: "Show me how Vermeer uses light"

    AI->>MCP: search_artwork(creator: "Vermeer", type: "painting")
    MCP-->>AI: 35 paintings found

    AI->>MCP: get_artwork_details("SK-A-2860")
    MCP-->>AI: The Milkmaid — title, date, materials, description…

    AI->>MCP: get_artwork_image("SK-A-2860")
    MCP-->>AI: interactive deep-zoom viewer opened for you

    AI->>MCP: inspect_artwork_image("SK-A-2860", region: "full")
    MCP-->>AI: base64 image (AI can see the painting)

    AI->>MCP: inspect_artwork_image("SK-A-2860", region: "pct:30,10,40,50")
    MCP-->>AI: cropped detail of the light from the window

    AI->>MCP: navigate_viewer(commands: [{action: "add_overlay", ...}])
    MCP-->>AI: overlay placed, viewer zoomed to region

    AI->>You: "Here's how Vermeer uses a single light source…"
```
