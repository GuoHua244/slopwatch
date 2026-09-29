/**
 * Image capture for the claude-code listener: Claude Code embeds image bytes
 * inline in the transcript — pasted screenshots ride the user message as
 * base64 source blocks, and tool results (Read on an image, screenshots)
 * return them inside the tool_result content. The listener hashes each image
 * the moment it sees the referencing record and ships the bytes as
 * attachment events alongside it, so dashboard readers get the pixels, not a
 * reference into a transcript that compaction will rewrite.
 */
import { createHash } from "node:crypto";
import {
  ATTACHMENT_MAX_BYTES,
  envelope,
  isObject,
  type AttachmentEvent,
  type TokenUsage,
  type TurnImageRef,
} from "@slopwatch/events";

export type InlineCapture = {
  origin: "user_message" | "tool_result";
  sessionId: string;
  occurredAt: string;
  /** shas already shipped this listener run — re-pastes dedupe to a ref. */
  seen: Set<string>;
  /** OUT: attachment events for newly captured images, in capture order. */
  attachments: AttachmentEvent[];
};

export type InlineImageBlock = { mediaType: string; data: string };

/** The image source blocks of a message content (string content → none). */
export const inlineImageBlocks = (content: unknown): InlineImageBlock[] => {
  if (!Array.isArray(content)) return [];
  const blocks: InlineImageBlock[] = [];
  for (const block of content) {
    if (!isObject(block) || block.type !== "image") continue;
    const source = block.source;
    if (
      isObject(source) &&
      source.type === "base64" &&
      typeof source.data === "string" &&
      source.data.length > 0 &&
      typeof source.media_type === "string"
    ) {
      blocks.push({ mediaType: source.media_type, data: source.data });
    }
  }
  return blocks;
};

/** Magic-byte sniffing — the block's own media_type label is not always
 * truthful (and old transcripts may omit it), so trust the bytes. */
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

/**
 * The mime comes from the bytes alone — the block's media_type label can
 * lie (zcode observed jpeg labels over png payloads), and a junk payload
 * wearing an image label must never ship as an attachment. Claude Code only
 * produces the four sniffable formats; anything else is skipped.
 */
const mimeOf = (bytes: Buffer): string | null => sniffImageMime(bytes);

export type CapturedImages = {
  /** Render refs for the referencing turn (1-based, per capture call). */
  refs: TurnImageRef[];
  /** shas for a ToolResultEvent reference. */
  shas: string[];
};

/**
 * Capture every inline image block of one message content. Oversized or
 * undecodable images are skipped entirely (fail open, visible only as a
 * missing attachment — never an event the server would reject).
 */
export const captureInlineImages = (
  content: unknown,
  capture: InlineCapture,
): CapturedImages => {
  const refs: TurnImageRef[] = [];
  const shas: string[] = [];
  for (const block of inlineImageBlocks(content)) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(block.data, "base64");
    } catch {
      continue;
    }
    if (bytes.length === 0 || bytes.length > ATTACHMENT_MAX_BYTES) continue;
    const mime = mimeOf(bytes);
    if (mime === null) continue;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!capture.seen.has(sha256)) {
      capture.seen.add(sha256);
      capture.attachments.push({
        ...envelope("claude-code", capture.sessionId, capture.occurredAt),
        kind: "attachment",
        sha256,
        mime,
        size: bytes.length,
        data: block.data,
        origin: capture.origin,
      });
    }
    if (!shas.includes(sha256)) shas.push(sha256);
    if (!refs.some((r) => r.sha256 === sha256)) {
      refs.push({ n: refs.length + 1, sha256, size: bytes.length });
    }
  }
  return { refs, shas };
};

/** Map transcript usage fields onto the wire's TokenUsage (last-wins — every
 * record of a message repeats the full-message usage). */
export const usageOf = (raw: unknown): TokenUsage | null => {
  if (!isObject(raw)) return null;
  const out: TokenUsage = {};
  if (typeof raw.input_tokens === "number") out.input_tokens = raw.input_tokens;
  if (typeof raw.output_tokens === "number")
    out.output_tokens = raw.output_tokens;
  if (typeof raw.cache_read_input_tokens === "number")
    out.cache_read_tokens = raw.cache_read_input_tokens;
  if (typeof raw.cache_creation_input_tokens === "number")
    out.cache_write_tokens = raw.cache_creation_input_tokens;
  return Object.keys(out).length > 0 ? out : null;
};
