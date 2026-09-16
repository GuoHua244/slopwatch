/** Response shaping shared by every plane of the HTTP app. */

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const text = (status: number, body: string): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/**
 * A prebuilt response thrown by the guards (requireUser/requireReader/
 * readJsonOr400 and the admin gate) as a control-flow sentinel; the single
 * catch at the top of fetch returns it. The thrown-for-returned equivalent
 * of the `if (x === null) return json(...)` prologues the guards replace —
 * same status, same body, at the same point in the evaluation order.
 */
export class HttpError extends Error {
  constructor(readonly response: Response) {
    super("response thrown as a control-flow sentinel");
    this.name = "HttpError";
  }
}
