/**
 * Image capture for the zcode listener: ZCode redacts image bytes from
 * model-io records (`[dataUrl omitted from model-io: …]`), leaving only the
 * local image-cache path — and the cache itself is pruned within hours, so a
 * bare path reference is worthless to server readers. The listener therefore
 * reads each image file the moment it sees the referencing record, hashes it
 * (sha256 dedup — conversation history re-echoes images on every request),
 * and ships the bytes as attachment events alongside the referencing one.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import {
  ATTACHMENT_MAX_BYTES,
  envelope,
  type AttachmentEvent,
  type TurnImageRef,
} from "@slopwatch/events";

/** The placeholder ZCode embeds in message text for an attached image. */
export const IMAGE_PLACEHOLDER = /\[Image: source: ([^\]]+)\]/g;

/** The render marker that replaces a captured placeholder. */
export const imageMarker = (n: number): string => `[image #${n}]`;

export type ImageOrigin = "user_message" | "tool_result";

/** Shared per-listener capture state: sha dedup plus an injectable reader. */
export type ImageCapture = {
  origin: ImageOrigin;
  sessionId: string;
  occurredAt: string;
  /** shas already shipped this listener run — history re-echoes images. */
  seen: Set<string>;
  /** Injectable for tests; defaults to a capped synchronous file read. */
  readImage?: (path: string) => Buffer | null;
  /** OUT: attachment events for newly captured images, in capture order. */
  attachments: AttachmentEvent[];
};

const defaultReadImage = (path: string): Buffer | null => {
  try {
    // size check first: readFileSync on a giant file wastes memory
    if (statSync(path).size > ATTACHMENT_MAX_BYTES) return null;
    const buf = readFileSync(path);
    return buf.length > 0 ? buf : null;
  } catch {
    return null; // pruned cache, unreadable, whatever — fail open
  }
};

/** Magic-byte sniffing — the rollout's own mime labels disagree with the
 * bytes (observed: mediaType jpeg over a png payload), so trust the file. */
export const sniffImageMime = (buf: Buffer): string | null => {
  if (
    buf.length >= 8 &&
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return "image/jpeg";
  const head = buf.length >= 6 ? buf.subarray(0, 6).toString("latin1") : "";
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return null;
};

type Captured = { sha256: string; size: number } | null;

const captureAtPath = (path: string, capture: ImageCapture): Captured => {
  const buf = (capture.readImage ?? defaultReadImage)(path);
  if (buf === null) return null;
  const sha256 = createHash("sha256").update(buf).digest("hex");
  if (capture.seen.has(sha256)) return { sha256, size: buf.length };
  const mime = sniffImageMime(buf);
  if (mime === null) return null; // not a decodable image — skip entirely
  capture.seen.add(sha256);
  capture.attachments.push({
    ...envelope("zcode", capture.sessionId, capture.occurredAt),
    kind: "attachment",
    sha256,
    mime,
    size: buf.length,
    data: buf.toString("base64"),
    origin: capture.origin,
  });
  return { sha256, size: buf.length };
};

export const blockImagePaths = (content: unknown): string[] => {
  if (!Array.isArray(content)) return [];
  const paths: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "image"
    ) {
      const source = (block as { source?: unknown }).source;
      if (
        typeof source === "object" &&
        source !== null &&
        typeof (source as { path?: unknown }).path === "string"
      ) {
        paths.push((source as { path: string }).path);
      }
    }
  }
  return paths;
};

/** Whether a message content carries at least one image block with a path. */
export const hasImageBlock = (content: unknown): boolean =>
  blockImagePaths(content).length > 0;

const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/**
 * Capture the images of a turn's input message and rewrite its text: every
 * `[Image: source: <path>]` placeholder whose file is readable becomes an
 * `[image #n]` marker matched to a TurnImageRef; unreadable ones keep the
 * original text (the dashboard renders those as "not archived"). Image blocks
 * without a text placeholder — image-only inputs — land as extra refs the
 * dashboard shows as a trailing strip.
 */
export const captureUserMessageImages = (
  text: string,
  blockPaths: string[],
  capture: ImageCapture,
): { text: string; refs: TurnImageRef[] } => {
  const candidates = [...blockPaths];
  for (const match of text.matchAll(IMAGE_PLACEHOLDER)) {
    if (!candidates.includes(match[1]!)) candidates.push(match[1]!);
  }
  // one capture per distinct path, so repeated placeholders share a ref
  const byPath = new Map<string, Captured>();
  for (const path of candidates) {
    if (!byPath.has(path)) byPath.set(path, captureAtPath(path, capture));
  }
  const byBasename = new Map(
    [...byPath].map(([path, img]) => [basename(path), img] as const),
  );

  const refs: TurnImageRef[] = [];
  const refForPath = (path: string): Captured => {
    const img = byPath.get(path) ?? byBasename.get(basename(path)) ?? null;
    if (img === null) return null;
    if (!refs.some((r) => r.sha256 === img.sha256)) {
      refs.push({ n: refs.length + 1, sha256: img.sha256, size: img.size });
    }
    return img;
  };

  const rewritten = text.replace(
    IMAGE_PLACEHOLDER,
    (original, path: string) => {
      const img = refForPath(path);
      return img === null
        ? original // cache already pruned — keep the path for the dim fallback
        : imageMarker(refs.find((r) => r.sha256 === img.sha256)!.n);
    },
  );
  // image blocks the text never mentions (image-only inputs) still render
  for (const path of blockPaths) refForPath(path);
  return { text: rewritten, refs };
};

/**
 * Capture images a tool returned (screenshots): every readable image block in
 * the tool message's content yields a sha for the ToolResultEvent reference.
 */
export const captureToolResultImages = (
  content: unknown,
  capture: ImageCapture,
): string[] => {
  const shas: string[] = [];
  for (const path of blockImagePaths(content)) {
    const img = captureAtPath(path, capture);
    if (img !== null && !shas.includes(img.sha256)) shas.push(img.sha256);
  }
  return shas;
};
