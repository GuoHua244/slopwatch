import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { deriveSigningKey, encodeKey, signRequest, type S3Config } from "./s3";

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

  test("encodeKey percent-encodes everything outside the RFC 3986 unreserved set", () => {
    // sub-delims S3 SigV4 requires encoded — encodeURIComponent leaves them raw
    expect(encodeKey("raw/zcode/sess_a'b!c(d)e/7.json")).toBe(
      "raw/zcode/sess_a%27b%21c%28d%29e/7.json",
    );
    // the unreserved set stays readable
    expect(encodeKey("raw/x/sess-keep._~42/1.json")).toBe(
      "raw/x/sess-keep._~42/1.json",
    );
    // a literal % in a session id encodes once, here (not double-decoded)
    expect(encodeKey("raw/x/sess_ab%20c/7.json")).toBe(
      "raw/x/sess_ab%2520c/7.json",
    );
    // separators survive per-segment encoding
    expect(encodeKey("raw/a b/sess/1.json")).toBe("raw/a%20b/sess/1.json");
  });
});
