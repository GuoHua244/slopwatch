import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

// v2 decision 21: fail visible — partial S3 config throws instead of
// silently disabling the cold archive.
const base = { DATABASE_URL: "postgres://test" };

describe("loadConfig S3 archive wiring", () => {
  test("no S3 vars → archiving off", () => {
    expect(loadConfig(base).s3).toBeNull();
  });

  test("all S3 vars → archive on, region defaulted", () => {
    const cfg = loadConfig({
      ...base,
      SLOPWATCH_S3_ENDPOINT: "http://minio:9000",
      SLOPWATCH_S3_BUCKET: "slopwatch-archive",
      SLOPWATCH_S3_ACCESS_KEY_ID: "key",
      SLOPWATCH_S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(cfg.s3).toEqual({
      endpoint: "http://minio:9000",
      bucket: "slopwatch-archive",
      accessKeyId: "key",
      secretAccessKey: "secret",
      region: "us-east-1",
    });
  });

  test("a partial S3 config throws instead of disabling archiving", () => {
    expect(() =>
      loadConfig({
        ...base,
        SLOPWATCH_S3_ENDPOINT: "http://minio:9000",
        SLOPWATCH_S3_BUCKET: "slopwatch-archive",
      }),
    ).toThrow(/partially configured/);
  });
});

// ADR 0005: the IdP as a second token issuer, all-or-none like the S3 block.
describe("loadConfig OIDC issuer wiring", () => {
  test("no OIDC vars → minted tokens only", () => {
    expect(loadConfig(base).oidc).toBeNull();
  });

  test("both vars → issuer on", () => {
    expect(
      loadConfig({
        ...base,
        SLOPWATCH_OIDC_ISSUER: "https://idp.example.com",
        SLOPWATCH_OIDC_AUDIENCE: "slopwatch",
      }).oidc,
    ).toEqual({ issuer: "https://idp.example.com", audience: "slopwatch" });
  });

  test("a partial OIDC config throws instead of silently failing logins", () => {
    expect(() =>
      loadConfig({
        ...base,
        SLOPWATCH_OIDC_ISSUER: "https://idp.example.com",
      }),
    ).toThrow(/partially configured/);
  });
});
