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
function stripZodEvalProbe(): Plugin {
  const PROBE = 'try{return new Function(""),!0}catch(r){return!1}';
  const REPLACEMENT = 'return!1';
  return {
    name: 'rijksmuseum:strip-zod-eval-probe',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@modelcontextprotocol/ext-apps')) return null;
      if (!code.includes(PROBE)) return null;
      return { code: code.split(PROBE).join(REPLACEMENT), map: null };
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
