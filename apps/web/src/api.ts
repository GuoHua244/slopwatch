/**
 * Facade for the client planes, now split under `api/`:
 * types.ts (row/response types), http.ts (fetch plumbing, ApiError,
 * bearer-auth, request timeout), read.ts / review.ts / admin.ts (the three
 * client factories). Re-exported here so `import … from "./api"` keeps
 * working everywhere.
 */
export * from "./api/types";
export * from "./api/http";
export * from "./api/read";
export * from "./api/review";
export * from "./api/admin";
export * from "./api/retro";
