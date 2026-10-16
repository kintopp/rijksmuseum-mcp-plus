// Live check: presign s3://<bucket>/<key> with Railway bucket credentials and fetch its
// first bytes. Prints status, size and gzip magic only — never the signed URL.
// Usage: node scripts/tests/probe-s3-presign.mjs <creds.json> [key]
//   creds.json: `railway bucket credentials --bucket <name> --json` (keep it 0600)
import { readFileSync } from "node:fs";
import { presignS3Get } from "../../dist/utils/s3Presign.js";

const [credsPath, key = "gemma/v2/gemma.db.gz"] = process.argv.slice(2);
if (!credsPath) {
  console.error("usage: node scripts/tests/probe-s3-presign.mjs <creds.json> [key]");
  process.exit(2);
}
const c = JSON.parse(readFileSync(credsPath, "utf8"));
const url = presignS3Get(`s3://${c.bucketName}/${key}`, {
  endpoint: c.endpoint,
  region: c.region || "auto",
  accessKeyId: c.accessKeyId,
  secretAccessKey: c.secretAccessKey,
}, 300);

const res = await fetch(url, { headers: { Range: "bytes=0-1" } });
const body = new Uint8Array(await res.arrayBuffer());
const total = res.headers.get("content-range")?.split("/")[1];
const magic = [...body].map(b => b.toString(16).padStart(2, "0")).join("");
console.log(`s3://${c.bucketName}/${key}: HTTP ${res.status}, size ${total ?? "?"} bytes, first bytes ${magic}`);
process.exit(res.status === 206 && magic === "1f8b" ? 0 : 1);
