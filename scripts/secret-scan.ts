/**
 * Secret scan — the standing guard for a public repo: nothing that looks
 * like a real credential enters version control (the API-key rule).
 *
 * Default mode walks EVERY object in .git — loose, packed, reachable or
 * dangling — via `git cat-file --batch-all-objects`, so a secret that ever
 * touched a commit (even one since rewritten) is found. `--staged` scans
 * only the staged worktree files, the cheap lint-staged pre-commit path.
 *
 * Two detection layers:
 * 1. Known-real values from the environment, when present. Bun loads the
 *    repo-root .env automatically, so a local run matches the operator's
 *    actual bearer tokens, MinIO password, and DSN passwords exactly; CI
 *    has no .env and simply skips this layer.
 * 2. Secret-shaped patterns over every blob: OpenAI-style `sk-` keys, the
 *    GLM/Zhipu key shape, AWS access keys, bot-webhook hosts, DSNs with
 *    passwords, long bearer literals. Deployment placeholders (CHANGE_ME,
 *    the compose-local `slopwatch:slopwatch` default, and friends) are
 *    allowlisted — they are documented, non-secret dev defaults.
 *
 * Exit 1 on any finding; prints each with the secret elided.
 */
import { readFileSync } from "node:fs";

/** Exact values from the local .env (absent on CI). */
const knownRealValues = (): string[] => {
  const tokenParts = (process.env.SLOPWATCH_TOKENS ?? "")
    .split(",")
    .map((pair) => pair.split(":")[1] ?? "")
    .filter((token) => token.length >= 10);
  return [
    process.env.SLOPWATCH_ADMIN_TOKEN,
    process.env.MINIO_ROOT_PASSWORD,
    process.env.MINIO_ROOT_USER,
    process.env.DATABASE_URL_TEST,
    process.env.DATABASE_URL,
    ...tokenParts,
  ].filter((v): v is string => typeof v === "string" && v.length >= 10);
};

/** DSN passwords that are documented, non-secret deployment defaults. */
const DSN_PLACEHOLDER_PASSWORDS = new Set([
  "change_me",
  "change-me",
  "changeme",
  "slopwatch",
  "test",
  "postgres",
  "password",
]);

const isAllowlistedDsnPassword = (password: string): boolean => {
  if (DSN_PLACEHOLDER_PASSWORDS.has(password.toLowerCase())) return true;
  // Documentation placeholders like <pw>, ${appPassword}, [password] —
  // anything bracketed is a slot for a real secret, not one.
  return /^[<$[{].+[>}\]]$/.test(password);
};

const patterns = (): [string, RegExp][] => [
  ["openai-style sk- key", /sk-[A-Za-z0-9_-]{16,}/g],
  // GLM/Zhipu key shape: 32 hex chars, a dot, then 10+ alphanumerics.
  ["zhipu-shaped key", /\b[0-9a-f]{32}\.[A-Za-z0-9]{10,}\b/g],
  ["aws access key id", /AKIA[0-9A-Z]{16}/g],
  [
    "bot-webhook host",
    /hooks\.slack\.com\/services|qyapi\.weixin\.qq\.com|open\.feishu\.cn\/open-apis|oapi\.dingtalk\.com/g,
  ],
  ["DSN with password", /postgres(?:ql)?:\/\/[A-Za-z0-9_]+:([^@\s]{4,})@/g],
  ["bearer literal", /\bBearer [A-Za-z0-9_\-]{28,}/g],
];

const findingsIn = (text: string): string[] => {
  const findings: string[] = [];
  for (const value of knownRealValues()) {
    if (text.includes(value)) findings.push("KNOWN-REAL-VALUE");
  }
  for (const [name, regex] of patterns()) {
    for (const match of text.matchAll(regex)) {
      if (name === "DSN with password") {
        const password = match[1] ?? "";
        if (isAllowlistedDsnPassword(password)) continue;
      }
      findings.push(`${name}(${match[0].slice(0, 24)}…)`);
      break;
    }
  }
  return [...new Set(findings)];
};

const elide = (text: string): string => {
  let out = text.replace(/\s+/g, " ").trim();
  for (const value of knownRealValues()) out = out.split(value).join("***");
  return out.length > 140 ? `${out.slice(0, 140)}…` : out;
};

const stagedPaths = (): string[] => {
  const out = Bun.spawnSync(
    ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"],
    { stdout: "pipe" },
  );
  return out.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

let hits = 0;
const report = (where: string, text: string): void => {
  const findings = findingsIn(text);
  if (findings.length === 0) return;
  hits += 1;
  console.log(`HIT ${where} [${findings.join(", ")}]`);
  console.log(`     ${elide(text)}`);
};

if (process.argv.includes("--staged")) {
  for (const path of stagedPaths()) {
    try {
      report(`staged:${path}`, readFileSync(path, "utf8"));
    } catch {
      // a staged path that vanished from the worktree cannot be scanned
    }
  }
  console.log(`secret-scan: ${hits} staged file(s) with findings`);
} else {
  const check = Bun.spawnSync(
    ["git", "cat-file", "--batch-all-objects", "--batch-check"],
    { stdout: "pipe" },
  );
  const totalObjects = check.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
  const proc = Bun.spawn(
    ["git", "cat-file", "--batch-all-objects", "--batch", "--buffer"],
    { stdout: "pipe", stderr: "pipe" },
  );
  // Byte-level framing: cat-file's sizes are BYTES, so buffering decoded
  // text and slicing by character count drifts out of sync on multi-byte
  // content and silently swallows objects (the bug CI caught). Everything
  // below accumulates raw bytes; only blob bodies get decoded.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const reader = proc.stdout.getReader();
  let bytes: number[] = [];
  let pendingSha = "";
  let pendingKind = "";
  let pendingSize = -1;
  let objectsSeen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const byte of value) bytes.push(byte);
    for (;;) {
      if (pendingSize === -1) {
        const nl = bytes.indexOf(10);
        if (nl === -1) break;
        const header = String.fromCharCode(...bytes.slice(0, nl));
        const [sha, kind, size] = header.split(" ");
        if (sha && kind && size && /^\d+$/.test(size)) {
          pendingSha = sha;
          pendingKind = kind;
          pendingSize = Number(size);
        }
        bytes = bytes.slice(nl + 1);
        continue;
      }
      if (bytes.length < pendingSize + 1) break;
      const body = new Uint8Array(bytes.slice(0, pendingSize));
      bytes = bytes.slice(pendingSize + 1);
      objectsSeen += 1;
      if (pendingKind === "blob")
        report(`blob ${pendingSha}`, decoder.decode(body));
      pendingSha = "";
      pendingSize = -1;
    }
  }
  // The completeness check is the point: a framing bug must fail loudly,
  // not silently shrink the audit surface.
  if (objectsSeen !== totalObjects) {
    console.log(
      `secret-scan: FRAMING BUG — parsed ${objectsSeen} of ${totalObjects} objects; refusing to pass`,
    );
    process.exit(1);
  }
  console.log(
    `secret-scan: ${totalObjects} objects walked, ${hits} with findings, across the whole .git`,
  );
}
process.exit(hits > 0 ? 1 : 0);
