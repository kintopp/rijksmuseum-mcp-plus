// Reads the viewer UI resource through the real MCP stdio server and asserts
// loadViewerHtml() returns the bundled viewer, not the "Viewer Not Built"
// fallback. Guards the dist/apps/index.html path resolution in registration.ts.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const RESOURCE_URI = "ui://rijksmuseum/artwork-viewer.html";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, MCP_SKIP_STARTUP_WARM: "1" },
});
const client = new Client({ name: "viewer-resource-test", version: "1.0.0" });

let failed = false;
try {
  await client.connect(transport);
  const res = await client.readResource({ uri: RESOURCE_URI });
  const html = res.contents?.[0]?.text ?? "";
  const isFallback = html.includes("Viewer Not Built");
  const isRealViewer = html.includes("Loading artwork") && html.length > 100000;
  console.log(`bytes=${html.length} fallback=${isFallback} realViewer=${isRealViewer}`);
  if (isFallback || !isRealViewer) {
    console.error("FAIL: viewer resource served the fallback / not the real bundle");
    failed = true;
  } else {
    console.log("PASS: viewer resource served the real bundled viewer");
  }
} catch (e) {
  console.error("FAIL:", e?.message ?? e);
  failed = true;
} finally {
  await client.close().catch(() => {});
}
process.exit(failed ? 1 : 0);
