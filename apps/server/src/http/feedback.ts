import { createHash } from "node:crypto";
import { FEEDBACK_KINDS, type FeedbackKind } from "../store/types";
import { HttpError, json } from "./respond";

/**
 * The feedback upload contract (ADR 0009): one multipart form carrying the
 * kind, the required text, and optional file parts under `files`. This is
 * the Server's first browser-initiated upload — everything else arrives as
 * Listener JSON — so the limits here are the intake's only guardrails.
 */
export const FEEDBACK_TEXT_MAX = 2000;
export const FEEDBACK_MAX_FILES = 10;
export const FEEDBACK_MAX_FILE_BYTES = 20 * 1024 * 1024;
const FEEDBACK_MAX_TOTAL_BYTES =
  FEEDBACK_MAX_FILE_BYTES * FEEDBACK_MAX_FILES + 32 * 1024 * 1024;

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const EXACT_MIMES = new Set([
  "application/pdf",
  "application/json",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);
const MIME_PREFIXES = [
  "text/",
  "application/vnd.openxmlformats-officedocument.",
];

/** Fallback when the browser sends no usable mime: extension → known type. */
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const mimeAllowed = (mime: string): boolean =>
  IMAGE_MIMES.has(mime) ||
  EXACT_MIMES.has(mime) ||
  MIME_PREFIXES.some((p) => mime.startsWith(p));

/** The concrete mime to store, or null when the type is not admissible. */
const resolveMime = (mime: string, filename: string): string | null => {
  // strip parameters ("text/plain;charset=utf-8" → "text/plain") and case
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base !== "" && mimeAllowed(base)) return base;
  const ext = filename.includes(".")
    ? (filename.split(".").pop() ?? "").toLowerCase()
    : "";
  return EXT_MIME[ext] ?? null;
};

export type FeedbackUpload = {
  kind: FeedbackKind;
  text: string;
  files: {
    sha256: string;
    filename: string;
    mime: string;
    size: number;
    data: Buffer;
  }[];
};

/** Parse and fully validate the feedback form; throws HttpError on any violation. */
export const parseFeedbackForm = async (
  req: Request,
): Promise<FeedbackUpload> => {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data"))
    throw new HttpError(
      json(400, { error: "feedback must be sent as multipart/form-data" }),
    );
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > FEEDBACK_MAX_TOTAL_BYTES)
    throw new HttpError(json(413, { error: "upload too large" }));

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(json(400, { error: "malformed multipart body" }));
  }

  const kind = form.get("kind");
  if (
    typeof kind !== "string" ||
    !FEEDBACK_KINDS.includes(kind as FeedbackKind)
  )
    throw new HttpError(
      json(400, {
        error: `kind must be one of: ${FEEDBACK_KINDS.join(", ")}`,
      }),
    );

  const rawText = form.get("text");
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (text.length === 0 || text.length > FEEDBACK_TEXT_MAX)
    throw new HttpError(
      json(400, {
        error: `text must be 1..${FEEDBACK_TEXT_MAX} characters`,
      }),
    );

  const rawFiles = form.getAll("files");
  if (rawFiles.length > FEEDBACK_MAX_FILES)
    throw new HttpError(
      json(400, { error: `at most ${FEEDBACK_MAX_FILES} attachments` }),
    );

  const files: FeedbackUpload["files"] = [];
  for (const entry of rawFiles) {
    if (typeof entry === "string")
      throw new HttpError(json(400, { error: "files must be file parts" }));
    if (entry.size === 0)
      throw new HttpError(json(400, { error: `${entry.name} is empty` }));
    if (entry.size > FEEDBACK_MAX_FILE_BYTES)
      throw new HttpError(
        json(413, {
          error: `${entry.name} exceeds the ${Math.floor(FEEDBACK_MAX_FILE_BYTES / (1024 * 1024))} MiB attachment limit`,
        }),
      );
    const mime = resolveMime(entry.type, entry.name);
    if (mime === null)
      throw new HttpError(
        json(415, {
          error: `${entry.name} has an unsupported type${entry.type ? ` (${entry.type})` : ""}`,
        }),
      );
    const data = Buffer.from(await entry.arrayBuffer());
    files.push({
      sha256: createHash("sha256").update(data).digest("hex"),
      filename: entry.name || "attachment",
      mime,
      size: data.length,
      data,
    });
  }

  return { kind: kind as FeedbackKind, text, files };
};
