import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for the outbound User-Agent. Reading package.json
// here mirrors index.ts's version resolution so the string never drifts.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8")
);

/**
 * Identifying User-Agent for outbound requests to Rijksmuseum / micr.io.
 * Replaces the default `axios/<ver>` so the museum can attribute MCP traffic
 * and reach the maintainer via the linked repo if something goes wrong.
 * e.g. "rijksmuseum-mcp-plus/0.60.0 (+https://github.com/kintopp/rijksmuseum-mcp-plus)"
 */
export const USER_AGENT = `${pkg.name}/${pkg.version} (+https://github.com/kintopp/rijksmuseum-mcp-plus)`;
