/**
 * SigV4 presigning for s3:// DB download URLs (src/utils/s3Presign.ts).
 *
 * Failure modes guarded:
 *  - canonical request / signing-key chain wrong → signature mismatch vs AWS's
 *    published example and a boto3-generated Tigris-style URL (hand-pasted fixtures)
 *  - key segments not RFC 3986-encoded (space, +, parens, non-ASCII) or "/" encoded
 *  - query params unsorted, or Expires/Date not taken from the arguments
 *  - path-style instead of virtual-hosted URL
 *  - partial S3_* env treated as usable; S3_REGION not defaulting to "auto"
 *  - non-s3 or key-less URL accepted
 *
 * Equivalent mutation: dropping the query `.sort()` survives — the params are
 * already built in canonical order.
 *
 * Run:  node scripts/tests/test-s3-presign.mjs
 * Requires: npm run build
 */
import { presignS3Get, s3CredentialsFromEnv } from "../../dist/utils/s3Presign.js";

let failed = 0;
function check(cond, msg) {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failed++;
}

// AWS "Authenticating Requests: Using Query Parameters" worked example.
const aws = presignS3Get(
  "s3://examplebucket/test.txt",
  {
    endpoint: "https://s3.amazonaws.com",
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
  86400,
  new Date("2013-05-24T00:00:00Z"),
);
check(
  aws === "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
    "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
    "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
    "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  "AWS documented example matches byte-for-byte",
);

// boto3 generate_presigned_url (virtual addressing, region auto) for an awkward key.
const tigris = presignS3Get(
  "s3://private-assets/gemma/v2/a b+(c)é.db.gz",
  {
    endpoint: "https://t3.storageapi.dev",
    region: "auto",
    accessKeyId: "tid_EXAMPLE",
    secretAccessKey: "tsec_EXAMPLE/KEY+1",
  },
  3600,
  new Date("2026-10-16T17:44:19Z"),
);
check(
  tigris === "https://private-assets.t3.storageapi.dev/gemma/v2/a%20b%2B%28c%29%C3%A9.db.gz" +
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=tid_EXAMPLE%2F20261016%2Fauto%2Fs3%2Faws4_request" +
    "&X-Amz-Date=20261016T174419Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host" +
    "&X-Amz-Signature=70b924208415f8b705e505cd11ccc33d138ecb83335ffb828a3146f6c7535681",
  "boto3 reference for an escaped multi-segment key matches byte-for-byte",
);

const creds = { endpoint: "https://t3.storageapi.dev", region: "auto", accessKeyId: "a", secretAccessKey: "b" };
for (const bad of ["https://example.com/x.gz", "s3://bucket-only", "s3://bucket/"]) {
  let threw = false;
  try { presignS3Get(bad, creds, 60); } catch { threw = true; }
  check(threw, `rejects ${bad}`);
}

check(
  JSON.stringify(s3CredentialsFromEnv({ S3_ENDPOINT: "https://e", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" })) ===
    JSON.stringify({ endpoint: "https://e", region: "auto", accessKeyId: "k", secretAccessKey: "s" }),
  "env credentials default region to auto",
);
check(
  s3CredentialsFromEnv({ S3_ENDPOINT: "https://e", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s", S3_REGION: "eu" })?.region === "eu",
  "S3_REGION overrides the default",
);
check(s3CredentialsFromEnv({ S3_ENDPOINT: "https://e", S3_ACCESS_KEY_ID: "k" }) === null, "missing secret → null");
check(s3CredentialsFromEnv({}) === null, "empty env → null");

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
