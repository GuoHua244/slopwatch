/**
 * Minimal S3-compatible object client for the raw-payload cold archive
 * (v2 decision 24). Zero-dependency SigV4 — the repo ships no AWS SDK and
 * the archive needs exactly PUT and GET against an S3-compatible endpoint
 * (MinIO in the compose deployment, AWS S3 or R2 elsewhere).
 */
import { createHash, createHmac } from "node:crypto";

export type S3Config = {
  /** e.g. "http://minio:9000" — path-style addressing is always used. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type S3Client = {
  putObject(key: string, body: string): Promise<void>;
  getObject(key: string): Promise<string>;
};

const sha256Hex = (data: string): string =>
  createHash("sha256").update(data, "utf8").digest("hex");

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/**
 * The SigV4 key-derivation chain, exported for the test suite that pins it
 * against the AWS-published worked example.
 */
export const deriveSigningKey = (
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer => {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
};

/** Object key URI-encoded per path segment (path-style /bucket/key URLs). */
const encodeKey = (key: string): string =>
  key.split("/").map(encodeURIComponent).join("/");

const amzDates = (now: Date): { amzDate: string; dateStamp: string } => {
  const iso = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
};

/**
 * Derive the SigV4 signature for one request. Exposed for the test suite,
 * which pins the derivation against the AWS-published test vectors.
 */
export const signRequest = (
  cfg: S3Config,
  method: string,
  key: string,
  payload: string,
  now: Date,
): { authorization: string; amzDate: string; payloadHash: string } => {
  const { amzDate, dateStamp } = amzDates(now);
  const payloadHash = sha256Hex(payload);
  const host = new URL(cfg.endpoint).host;
  // path-style virtual hosting: /bucket/key, key URI-encoded per segment
  const canonicalUri = `/${cfg.bucket}/${encodeKey(key)}`;
  const canonicalHeaders =
    `content-type:application/octet-stream\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kSigning = deriveSigningKey(
    cfg.secretAccessKey,
    dateStamp,
    cfg.region,
    "s3",
  );
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, amzDate, payloadHash };
};

export const createS3Client = (cfg: S3Config): S3Client => {
  const request = async (
    method: string,
    key: string,
    body: string | null,
  ): Promise<Response> => {
    const payload = body ?? "";
    const { authorization, amzDate, payloadHash } = signRequest(
      cfg,
      method,
      key,
      payload,
      new Date(),
    );
    const url = `${cfg.endpoint.replace(/\/+$/, "")}/${cfg.bucket}/${encodeKey(key)}`;
    return fetch(url, {
      method,
      headers: {
        "content-type": "application/octet-stream",
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        authorization,
        ...(body !== null
          ? { "content-length": String(Buffer.byteLength(body, "utf8")) }
          : {}),
      },
      ...(body !== null ? { body } : {}),
    });
  };

  return {
    putObject: async (key, body) => {
      const res = await request("PUT", key, body);
      if (!res.ok) {
        throw new Error(
          `s3 putObject ${key} failed: ${res.status} ${await res.text().catch(() => "")}`,
        );
      }
    },
    getObject: async (key) => {
      const res = await request("GET", key, null);
      if (!res.ok) {
        throw new Error(`s3 getObject ${key} failed: ${res.status}`);
      }
      return res.text();
    },
  };
};
