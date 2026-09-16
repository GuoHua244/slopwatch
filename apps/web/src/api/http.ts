/**
 * The shared HTTP plumbing for every client plane: the minimal fetch
 * surface, the ApiError carrier, the body-unwrap helpers, and the one
 * bearer-auth factory all three planes previously duplicated.
 */

/**
 * Minimal fetch surface the client needs (string URL in, Response out).
 * The global fetch satisfies it; tests inject stubs.
 */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Hard ceiling on a single real request; a hung server must not hang a tick. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The default doFetch: the global fetch with a 10s abort timeout attached.
 * Injected test fetches bypass this wrapper entirely (factories take the
 * stub directly), so stubs see exactly the init the caller built.
 */
export const defaultFetch: FetchLike = (input, init) =>
  fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly method = "GET",
    detail?: string,
  ) {
    super(
      `${method} ${path} failed with ${status}${detail ? ` — ${detail}` : ""}`,
    );
    this.name = "ApiError";
  }
}

/** The server's `{ error }` body text, when it sent one. */
export const errorDetail = async (
  res: Response,
): Promise<string | undefined> => {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
};

export const getJson = async <T>(
  doFetch: FetchLike,
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const res = await doFetch(path, init);
  if (!res.ok)
    throw new ApiError(res.status, path, "GET", await errorDetail(res));
  return (await res.json()) as T;
};

export const unwrapJson = async <T = void>(
  doFetch: FetchLike,
  path: string,
  init: RequestInit,
  method: string,
): Promise<T> => {
  const res = await doFetch(path, init);
  if (!res.ok)
    throw new ApiError(res.status, path, method, await errorDetail(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
};

/**
 * One bearer-auth request-init builder shared by the read, review, and admin
 * planes: merges the token's authorization header into whatever init the
 * caller passes. A null token omits the header (anonymous reads); an empty
 * string still sends it (the admin plane's contract).
 */
export const bearerAuth =
  (getToken: () => string | null) =>
  (init: RequestInit = {}): RequestInit => {
    const token = getToken();
    return {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      },
    };
  };
