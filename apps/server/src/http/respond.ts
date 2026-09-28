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
 * One stored attachment's bytes as an immutable response — sha256-addressed
 * rows are safe to cache forever, and `private` keeps them out of shared
 * proxy caches. Extra headers (e.g. content-disposition) merge over the base.
 */
export const attachmentResponse = (
  attachment: { data: Uint8Array; mime: string },
  headers: Record<string, string> = {},
): Response =>
  new Response(
    // copy into a plain ArrayBuffer-backed view: pg's Buffer keeps
    // ArrayBufferLike, which BlobPart rejects
    new Blob([new Uint8Array(attachment.data)], { type: attachment.mime }),
    {
      headers: {
        "content-type": attachment.mime,
        "cache-control": "private, max-age=31536000, immutable",
        ...headers,
      },
    },
  );

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
