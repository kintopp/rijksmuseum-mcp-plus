# justfile — CLI-only workflow for rijksmuseum-mcp-plus. Run `just` to list recipes.
# Requires Node.js 24.x (>=24.14.1 <25) and the `just` runner (https://github.com/casey/just).
set positional-arguments

# Default transport is stdio. To route every recipe through a running HTTP
# server instead, uncomment and point at the server's /mcp endpoint:
# export RIJKS_MCP_HTTP := "https://rijksmuseum-mcp-plus-production.up.railway.app/mcp"

# List recipes.
default:
    @just --list

# Install dependencies (run once).
install:
    npm install

# Build the server bundle — required for the default stdio transport.
build:
    npm run build

# Run a CLI verb, e.g. `just cli semantic "ships in a storm" --max 10`
cli *args:
    npm run cli -- "$@"

# Start a local HTTP server on :3000 (alternative to the public one; needs build + DBs).
serve:
    npm run serve
