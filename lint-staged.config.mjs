export default {
  // The API-key rule for a public repo: nothing secret-shaped is committed;
  // CI runs the whole-.git scan on top of this staged-file check.
  "*": () => "bun scripts/secret-scan.ts --staged",
  "*.{ts,tsx}": ["prettier --write", () => "bun run typecheck"],
  "*.{js,mjs,cjs,json,md,yml,yaml}": "prettier --write",
};
