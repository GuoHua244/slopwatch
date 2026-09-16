import {
  ApiError,
  bearerAuth,
  defaultFetch,
  errorDetail,
  type FetchLike,
} from "./http";
import type {
  AdminHealth,
  AdminTeamRow,
  AdminTokenRow,
  AdminUserRow,
  AuditRow,
  MintedToken,
  QuarantineRow,
} from "./types";

export type AdminApi = {
  users(): Promise<AdminUserRow[]>;
  createUser(name: string, email: string | null): Promise<AdminUserRow>;
  setUserDisabled(name: string, disabled: boolean): Promise<void>;
  setUserDri(name: string, isDri: boolean): Promise<void>;
  setUserRole(name: string, role: "admin" | "member"): Promise<void>;
  deleteUser(name: string): Promise<void>;
  mintToken(name: string): Promise<MintedToken>;
  tokens(name: string): Promise<AdminTokenRow[]>;
  revokeToken(tokenId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  health(): Promise<AdminHealth>;
  quarantine(limit?: number): Promise<QuarantineRow[]>;
  /**
   * ADR 0007: the audit log, newest first. `kind` prefixes the action
   * ("user" matches user.*); `actor` substring-matches the acting user or
   * names the operator/system pseudo-actors; `offset` pages within the
   * filtered `total`.
   */
  audit(params?: {
    limit?: number;
    offset?: number;
    kind?: string;
    actor?: string;
  }): Promise<{ rows: AuditRow[]; total: number }>;
  teams(): Promise<AdminTeamRow[]>;
  settings(): Promise<Record<string, string>>;
  updateSettings(patch: Record<string, string>): Promise<void>;
  testWebhook(): Promise<void>;
  createTeam(
    name: string,
    rawRetentionDays: number | null,
  ): Promise<AdminTeamRow>;
  updateTeam(
    id: string,
    patch: { name?: string; raw_retention_days?: number | null },
  ): Promise<void>;
  deleteTeam(id: string): Promise<void>;
  setUserTeam(name: string, teamId: string | null): Promise<void>;
};

/** Admin plane client (decision 13); every call carries the admin bearer. */
export const createAdminApi = (
  adminToken: () => string,
  doFetch: FetchLike = defaultFetch,
): AdminApi => {
  const auth = bearerAuth(adminToken);
  const authedJson = (method: string, body: unknown): RequestInit =>
    auth({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const unwrap = async <T>(path: string, init: RequestInit): Promise<T> => {
    const res = await doFetch(path, init);
    if (!res.ok)
      throw new ApiError(
        res.status,
        path,
        init.method ?? "GET",
        await errorDetail(res),
      );
    return (await res.json()) as T;
  };
  return {
    users: async () =>
      (
        await unwrap<{ users: AdminUserRow[] }>(
          "/admin/users",
          auth({ method: "GET" }),
        )
      ).users,
    createUser: async (name, email) =>
      (
        await unwrap<{ user: AdminUserRow }>(
          "/admin/users",
          authedJson("POST", { name, email }),
        )
      ).user,
    setUserDisabled: async (name, disabled) => {
      await unwrap(
        `/admin/users/${encodeURIComponent(name)}`,
        authedJson("PATCH", { disabled }),
      );
    },
    setUserDri: async (name, isDri) => {
      await unwrap(
        `/admin/users/${encodeURIComponent(name)}`,
        authedJson("PATCH", { is_dri: isDri }),
      );
    },
    setUserRole: async (name, role) => {
      await unwrap(
        `/admin/users/${encodeURIComponent(name)}`,
        authedJson("PATCH", { role }),
      );
    },
    deleteUser: async (name) => {
      await unwrap(
        `/admin/users/${encodeURIComponent(name)}`,
        auth({ method: "DELETE" }),
      );
    },
    mintToken: async (name) =>
      unwrap<MintedToken>(
        `/admin/users/${encodeURIComponent(name)}/tokens`,
        auth({ method: "POST" }),
      ),
    tokens: async (name) =>
      (
        await unwrap<{ tokens: AdminTokenRow[] }>(
          `/admin/users/${encodeURIComponent(name)}/tokens`,
          auth({ method: "GET" }),
        )
      ).tokens,
    revokeToken: async (tokenId) => {
      await unwrap(
        `/admin/tokens/${encodeURIComponent(tokenId)}`,
        auth({ method: "DELETE" }),
      );
    },
    deleteSession: async (sessionId) => {
      await unwrap(
        `/admin/sessions/${encodeURIComponent(sessionId)}`,
        auth({ method: "DELETE" }),
      );
    },
    health: async () =>
      unwrap<AdminHealth>("/admin/health", auth({ method: "GET" })),
    quarantine: async (limit = 50) =>
      (
        await unwrap<{ rows: QuarantineRow[] }>(
          `/admin/quarantine?limit=${limit}`,
          auth({ method: "GET" }),
        )
      ).rows,
    audit: async (params = {}) => {
      const search = new URLSearchParams();
      if (params.limit !== undefined) search.set("limit", String(params.limit));
      if (params.offset !== undefined)
        search.set("offset", String(params.offset));
      if (params.kind !== undefined) search.set("kind", params.kind);
      if (params.actor !== undefined) search.set("actor", params.actor);
      const query = search.toString();
      return unwrap<{ rows: AuditRow[]; total: number }>(
        `/admin/audit${query ? `?${query}` : ""}`,
        auth({ method: "GET" }),
      );
    },
    teams: async () =>
      (
        await unwrap<{ teams: AdminTeamRow[] }>(
          "/admin/teams",
          auth({ method: "GET" }),
        )
      ).teams,
    settings: async () =>
      (
        await unwrap<{ settings: Record<string, string> }>(
          "/admin/settings",
          auth({ method: "GET" }),
        )
      ).settings,
    updateSettings: async (patch) => {
      await unwrap("/admin/settings", authedJson("PUT", patch));
    },
    testWebhook: async () => {
      await unwrap("/admin/webhook/test", auth({ method: "POST" }));
    },
    createTeam: async (name, rawRetentionDays) =>
      unwrap<{ team: AdminTeamRow }>(
        "/admin/teams",
        authedJson("POST", {
          name,
          ...(rawRetentionDays !== null
            ? { raw_retention_days: rawRetentionDays }
            : {}),
        }),
      ).then((r) => r.team),
    updateTeam: async (id, patch) => {
      await unwrap(
        `/admin/teams/${encodeURIComponent(id)}`,
        authedJson("PATCH", patch),
      );
    },
    deleteTeam: async (id) => {
      await unwrap(
        `/admin/teams/${encodeURIComponent(id)}`,
        auth({ method: "DELETE" }),
      );
    },
    setUserTeam: async (name, teamId) => {
      await unwrap(
        `/admin/users/${encodeURIComponent(name)}`,
        authedJson("PATCH", { team_id: teamId }),
      );
    },
  };
};
