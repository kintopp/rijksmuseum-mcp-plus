import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';

// ChatGPT's MCP-Apps iframe enforces a strict CSP that omits 'unsafe-eval',
// and the OpenAI Apps SDK does not expose an opt-in. The Zod v4 instance
// bundled into @modelcontextprotocol/ext-apps/app-with-deps runs a JIT-path
// probe — `try { new Function("") } catch { return false }` — at module load.
// Even though the throw is caught, Chromium still fires a `securitypolicyviolation`
// event that ChatGPT's host frame observes; in practice this leaves the
// "Loading artwork" viewer hanging forever (host→iframe leg of the ui/* bridge
// never delivers the tool result). Patching the probe to return false
// synchronously eliminates the CSP-violation event entirely, forcing Zod into
// its interpreter fallback. The JIT compile() method is gated by this probe
// (`o = g && Cu.value`) so it stays unreachable. See conversation 2026-05-14.
// Zod's source form and ext-apps' pre-minified copy (whose catch-variable
// name and quote style shift between releases) both need matching; the build
// fails if any probe survives, since a silent miss re-breaks ChatGPT-Chrome
// with a green build.
const ZOD_EVAL_PROBES: [RegExp, string][] = [
  [/try\s*\{\s*return\s+(?:new\s+)?Function\(\s*(?:""|''|``)\s*\)\s*,\s*!0\s*\}\s*catch\s*(?:\(\s*[\w$]+\s*\))?\s*\{\s*return\s*!1\s*\}/g, 'return!1'],
  [/const\s+F\s*=\s*Function;\s*new\s+F\(\s*(?:""|'')\s*\);\s*return\s+true;/g, 'return false;'],
];
const ANY_EVAL_PROBE = /(?:Function|new\s+[\w$]+)\(\s*(?:""|''|``)\s*\)/;

function stripZodEvalProbe(): Plugin {
  return {
    name: 'rijksmuseum:strip-zod-eval-probe',
    enforce: 'pre',
    transform(code, id) {
      if (!/node_modules\/(@modelcontextprotocol|zod)\//.test(id)) return null;
      let out = code;
      for (const [re, replacement] of ZOD_EVAL_PROBES) out = out.replace(re, replacement);
      return out === code ? null : { code: out, map: null };
    },
    generateBundle(_opts, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) {
        const text = chunk.type === 'chunk' ? chunk.code : String(chunk.source);
        if (ANY_EVAL_PROBE.test(text)) this.error(`Zod eval probe survived in ${name}; update ZOD_EVAL_PROBES`);
      }
    },
  };
}

export default defineConfig({
  plugins: [stripZodEvalProbe(), viteSingleFile()],
  root: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, '../../dist/apps'),
    emptyOutDir: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
  },
});
