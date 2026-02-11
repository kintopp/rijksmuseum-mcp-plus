import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';

export default defineConfig({
  plugins: [viteSingleFile()],
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
  resolve: {
    alias: {
      '@modelcontextprotocol/ext-apps':
        'https://unpkg.com/@modelcontextprotocol/ext-apps@1.0.1/app-with-deps',
    },
  },
});
