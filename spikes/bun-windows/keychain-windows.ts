/**
 * Spike: secret storage on Windows from Bun — how `slopwatch login <token>`
 * would persist the bearer token. A) Credential Manager via cmdkey
 * (add/list/delete) from a spawned process. B) DPAPI user-scoped
 * protect/unprotect round-trip via PowerShell (.NET), the file-fallback shape.
 */
import { spawnSync } from "node:child_process";

const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    status: r.status,
    out: ((r.stdout || "") + (r.stderr || "")).trim(),
  };
};

const ps = (command: string) =>
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ]);

// A) Credential Manager via cmdkey
const target = "slopwatch-spike-credman";
const added = run("cmdkey", [
  "/generic:" + target,
  "/user:slopwatch",
  "/pass:spike-secret-123",
]);
const listed = run("cmdkey", ["/list:" + target]);
const deleted = run("cmdkey", ["/delete:" + target]);
const credmanOk =
  added.status === 0 &&
  listed.status === 0 &&
  listed.out.includes(target) &&
  deleted.status === 0;
console.log(
  `SPIKE keychain credman(cmdkey): ${credmanOk ? "PASS" : "FAIL"} — add=${added.status} list=${listed.status} delete=${deleted.status}`,
);
if (!credmanOk)
  console.log("  cmdkey output:", added.out, "|", listed.out, "|", deleted.out);

// B) DPAPI round-trip (CurrentUser scope)
const secret = "slopwatch-spike-secret";
const t0 = Date.now();
const protected64 = ps(
  "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('" +
    secret +
    "'), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))",
);
const unprotected = ps(
  "Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('" +
    protected64.out.trim() +
    "'), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))",
);
const dpapiOk = unprotected.out.trim() === secret;
console.log(
  `SPIKE keychain dpapi: ${dpapiOk ? "PASS" : "FAIL"} — round-trip in ${Date.now() - t0}ms; recovered=${JSON.stringify(unprotected.out.trim())}`,
);
if (!dpapiOk)
  console.log(
    "  protect out:",
    protected64.out.slice(0, 200),
    "| unprotect out:",
    unprotected.out.slice(0, 200),
  );
