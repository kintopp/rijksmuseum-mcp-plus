import { createHash, createHmac } from "node:crypto";

export interface S3Credentials {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** S3 credentials from `S3_*` env vars, or null when any required one is missing. */
export function s3CredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): S3Credentials | null {
  const { S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!S3_ENDPOINT || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null;
  return {
    endpoint: S3_ENDPOINT,
    region: env.S3_REGION || "auto",
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  };
}

const rfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());

const hmac = (key: Buffer | string, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/**
 * SigV4 query-string presigned GET for `s3://bucket/key`, virtual-hosted style
 * (`https://bucket.<endpoint host>/key`) — Railway's Tigris endpoint requires it.
 */
export function presignS3Get(s3Url: string, creds: S3Credentials, expiresSeconds: number, now = new Date()): string {
  const u = new URL(s3Url);
  if (u.protocol !== "s3:" || !u.hostname || u.pathname.length < 2) throw new Error("expected s3://bucket/key");
  const bucket = u.hostname;
  const key = decodeURIComponent(u.pathname.slice(1));
  const endpoint = new URL(creds.endpoint);
  const host = `${bucket}.${endpoint.host}`;

  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${creds.region}/s3/aws4_request`;
  const canonicalUri = "/" + key.split("/").map(rfc3986).join("/");
  const query = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${creds.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ].map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).sort().join("&");

  const canonicalRequest = ["GET", canonicalUri, query, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  let signingKey = hmac("AWS4" + creds.secretAccessKey, day);
  for (const part of [creds.region, "s3", "aws4_request"]) signingKey = hmac(signingKey, part);
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return `${endpoint.protocol}//${host}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
}
