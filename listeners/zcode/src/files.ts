/**
 * File-attachment capture for the zcode listener. Non-image files reach the
 * model through three observed channels (2026-09 spike, sess_6d41bb57 /
 * sess_3de44100), and each needs its own byte source:
 *
 * - PDF: a `{type:"file"}` block whose `dataUrl` carries the FULL base64
 *   bytes (unlike images, ZCode does not redact them) plus a
 *   `[PDF: source: <original path>]` placeholder in an adjacent text block.
 * - Other binaries (docx/xlsx/zip, mime always application/octet-stream): a
 *   plain text block `Attached application/octet-stream: <absolute path>`
 *   followed by reader instructions — bytes only on disk, so read them the
 *   moment the record is seen (the same fail-open pattern as images.ts).
 * - Text files (md/py/csv): a synthetic "Called the Read tool …" transcript
 *   inlined in the message text — content is already captured as user
 *   message text, so no bytes are shipped for these.
 *
 * Everything is sha256-deduped through the same per-listener seen set as
 * images, capped at FILE_MAX_BYTES, and shipped as ordinary attachment
 * events; the turn carries the render refs.
 */
import { createHash } from "node:crypto";
import {
  attachmentCapBytes,
  envelope,
  isAttachmentMime,
  isNonEmptyString,
  isObject,
  MAX_FILES_PER_REF,
  type AttachmentEvent,
  type TurnFileRef,
} from "@slopwatch/events";
import { basename, readCapped, type AttachmentCapture } from "./images";

/** The placeholder ZCode embeds for an attached PDF (or a future "File"). */
export const FILE_PLACEHOLDER = /\[(?:PDF|File): source: ([^\]]+)\]/g;

/** Non-global companion for .test() — a /g regex would carry lastIndex. */
export const FILE_PLACEHOLDER_SCAN = new RegExp(FILE_PLACEHOLDER.source);

/** The render marker that replaces a captured file reference. */
export const fileMarker = (n: number): string => `[file #${n}]`;

/** A file the turn's input references, before bytes are captured. */
export type FileCandidate = {
  path?: string;
  dataUrl?: string;
  name: string;
  mime: string;
};

/** Extension → mime for the common local-file cases ZCode sends path-only. */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/x-wav",
};

const mimeFor = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
};

/** The `Attached <mime>: <path>` marker line's path, when the block is one. */
export const attachedFilePath = (text: string): string | null => {
  const firstLine = text.trimStart().split("\n", 1)[0] ?? "";
  const match = firstLine.match(/^Attached\s+[^\s:]+:\s+(.+)$/);
  return match ? match[1]!.trim() : null;
};

/**
 * Collect the turn input's file candidates from its content blocks: file
 * blocks (PDF today, video by engine parity), and `Attached <mime>: <path>`
 * text blocks. Synthetic Read transcripts are deliberately not candidates —
 * their content already rides in the message text itself.
 */
export const userFileCandidates = (content: unknown): FileCandidate[] => {
  if (!Array.isArray(content)) return [];
  const candidates: FileCandidate[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "file" || block.type === "video") {
      const source = isObject(block.source) ? block.source : {};
      const path = isNonEmptyString(source.path) ? source.path : undefined;
      const dataUrl =
        typeof block.dataUrl === "string" ? block.dataUrl : undefined;
      const name = isNonEmptyString(block.name)
        ? block.name
        : path !== undefined
          ? basename(path)
          : "attachment";
      // Coerce an unexpected mediaType to the allowlist's catch-all: an
      // event the server rejects fails the whole ingest batch.
      const mime =
        typeof block.mediaType === "string" && isAttachmentMime(block.mediaType)
          ? block.mediaType
          : mimeFor(name);
      candidates.push({ path, dataUrl, name, mime });
      continue;
    }
    if (block.type === "text" && isNonEmptyString(block.text)) {
      const path = attachedFilePath(block.text);
      if (path !== null) {
        candidates.push({ path, name: basename(path), mime: mimeFor(path) });
      }
    }
  }
  return candidates;
};

/** Whether a message content carries at least one file/video block. */
export const hasFileBlock = (content: unknown): boolean =>
  Array.isArray(content) &&
  content.some(
    (block) =>
      isObject(block) && (block.type === "file" || block.type === "video"),
  );

type Captured = { sha256: string; size: number } | null;

const captureCandidate = (
  candidate: FileCandidate,
  capture: AttachmentCapture,
): Captured => {
  const cap = attachmentCapBytes(candidate.mime);
  let buf: Buffer | null = null;
  if (
    candidate.dataUrl !== undefined &&
    candidate.dataUrl.startsWith("data:")
  ) {
    const comma = candidate.dataUrl.indexOf(",");
    // base64 is ~4/3 of the byte count: reject oversized payloads before
    // decoding — a record with a huge dataUrl must not be materialized
    if (
      comma > 0 &&
      candidate.dataUrl.length - comma - 1 <= Math.ceil((cap * 4) / 3) + 4
    ) {
      buf = Buffer.from(candidate.dataUrl.slice(comma + 1), "base64");
      if (buf.length === 0) buf = null;
    }
  }
  if (buf === null && candidate.path !== undefined) {
    buf = (capture.readFile ?? ((path) => readCapped(path, cap)))(
      candidate.path,
    );
  }
  if (buf === null || buf.length === 0 || buf.length > cap) {
    return null;
  }
  const sha256 = createHash("sha256").update(buf).digest("hex");
  if (capture.seen.has(sha256)) return { sha256, size: buf.length };
  capture.seen.add(sha256);
  capture.attachments.push({
    ...envelope("zcode", capture.sessionId, capture.occurredAt),
    kind: "attachment",
    sha256,
    mime: candidate.mime,
    size: buf.length,
    data: buf.toString("base64"),
    origin: capture.origin,
  });
  return { sha256, size: buf.length };
};

/**
 * Capture every candidate's bytes and turn the successes into render refs.
 * Duplicate candidates (same sha) share one ref, mirroring images.ts; the
 * refs stop at MAX_FILES_PER_REF — a longer list fails ingest and would lose
 * the whole batch. Order is candidate order, so `[file #n]` markers are
 * stable across history re-echoes of the same turn.
 */
export const captureFileCandidates = (
  candidates: FileCandidate[],
  capture: AttachmentCapture,
): { refs: TurnFileRef[]; refByPath: Map<string, TurnFileRef> } => {
  const refs: TurnFileRef[] = [];
  const refBySha = new Map<string, TurnFileRef>();
  const refByPath = new Map<string, TurnFileRef>();
  for (const candidate of candidates) {
    if (refs.length >= MAX_FILES_PER_REF) break;
    const got = captureCandidate(candidate, capture);
    if (got === null) continue;
    let ref = refBySha.get(got.sha256);
    if (ref === undefined) {
      ref = {
        n: refs.length + 1,
        sha256: got.sha256,
        size: got.size,
        name: candidate.name,
        mime: candidate.mime,
      };
      refs.push(ref);
      refBySha.set(got.sha256, ref);
    }
    if (candidate.path !== undefined && !refByPath.has(candidate.path)) {
      refByPath.set(candidate.path, ref);
    }
  }
  return { refs, refByPath };
};
