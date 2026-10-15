// Stream a .gz URL to a decompressed file (for containers without curl/wget).
// Usage: node fetch-gunzip.mjs <url> <out>
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const [url, out] = process.argv.slice(2);
const t0 = Date.now();
const res = await fetch(url);
if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
await pipeline(Readable.fromWeb(res.body), createGunzip(), createWriteStream(out));
console.log(`wrote ${out} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
