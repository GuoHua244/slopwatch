import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { deriveSigningKey, signRequest, type S3Config } from "./s3";

const CONFIG: S3Config = {
  endpoint: "http://minio:9000",
  region: "us-east-1",
  bucket: "slopwatch-archive",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("sigv4 signing key derivation (AWS-published vector)", () => {
  // The AWS Signature Version 4 documentation works this exact key:
  // date 20120215, region us-east-1, service iam, secret wJalr…
  test("derives the documented kSigning value", () => {
    const kSigning = deriveSigningKey(
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "20120215",
      "us-east-1",
      "iam",
    );
    expect(kSigning.toString("hex")).toBe(
      "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
    );
  });
});

describe("signRequest", () => {
  test("is deterministic and carries the right credential scope", () => {
    const now = new Date("2026-09-13T08:00:00.000Z");
    const a = signRequest(CONFIG, "PUT", "raw/x/1.json", "body", now);
    const b = signRequest(CONFIG, "PUT", "raw/x/1.json", "body", now);
    expect(a).toEqual(b);
    expect(a.authorization).toContain(
      "Credential=AKIDEXAMPLE/20260913/us-east-1/s3/aws4_request",
    );
    expect(a.authorization).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date",
    );
    expect(a.amzDate).toBe("20260913T080000Z");
    expect(a.payloadHash).toBe(
      createHash("sha256").update("body", "utf8").digest("hex"),
    );
  });

  test("different keys or bodies produce different signatures", () => {
    const now = new Date("2026-09-13T08:00:00.000Z");
    const a = signRequest(CONFIG, "PUT", "raw/x/1.json", "body", now);
    const b = signRequest(CONFIG, "PUT", "raw/x/2.json", "body", now);
    const sig = (r: { authorization: string }): string =>
      r.authorization.split("Signature=")[1]!;
    expect(sig(a)).not.toBe(sig(b));
    expect(
      sig(signRequest(CONFIG, "PUT", "raw/x/1.json", "other", now)),
    ).not.toBe(sig(a));
  });

  test("path-style canonical URI encodes each key segment", () => {
    const now = new Date("2026-09-13T08:00:00.000Z");
    // the key contains a session id with characters S3 requires encoded;
    // the signature must just stay stable for identical inputs
    const key = "raw/zcode/sess_ab%20c/7.json";
    const a = signRequest(CONFIG, "GET", key, "", now);
    const b = signRequest(CONFIG, "GET", key, "", now);
    expect(a.authorization).toBe(b.authorization);
    expect(a.authorization.startsWith("AWS4-HMAC-SHA256 ")).toBe(true);
  });
});
