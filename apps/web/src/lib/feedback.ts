import type { FeedbackKind } from "../api";

export const FEEDBACK_KINDS: FeedbackKind[] = [
  "missing_content",
  "wrong_data",
  "compatibility",
  "feature_suggestion",
  "other",
];

export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  missing_content: "Missing content",
  wrong_data: "Wrong data",
  compatibility: "Compatibility",
  feature_suggestion: "Feature suggestion",
  other: "Other",
};

export const FEEDBACK_TEXT_MAX = 2000;
export const FEEDBACK_MAX_FILES = 10;
export const FEEDBACK_MAX_FILE_BYTES = 20 * 1024 * 1024;

/** The browser-side accept list — the server re-validates the real bytes. */
export const FEEDBACK_ACCEPT =
  ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.log,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx";

const FEEDBACK_EXTS = new Set(
  FEEDBACK_ACCEPT.split(",").map((ext) => ext.slice(1)),
);

const typeAdmissible = (type: string): boolean =>
  type.startsWith("text/") ||
  type.startsWith("image/") ||
  [
    "application/pdf",
    "application/json",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
  ].includes(type) ||
  type.startsWith("application/vnd.openxmlformats-officedocument.");

/** Client-side mirror of the server's attachment contract; null = admissible. */
export const feedbackFilesError = (files: File[]): string | null => {
  if (files.length > FEEDBACK_MAX_FILES)
    return `at most ${FEEDBACK_MAX_FILES} attachments`;
  for (const file of files) {
    if (file.size === 0) return `${file.name} is empty`;
    if (file.size > FEEDBACK_MAX_FILE_BYTES)
      return `${file.name} exceeds the 20 MiB attachment limit`;
    const ext = file.name.includes(".")
      ? (file.name.split(".").pop() ?? "").toLowerCase()
      : "";
    if (!typeAdmissible(file.type) && !FEEDBACK_EXTS.has(ext))
      return `${file.name} has an unsupported type`;
  }
  return null;
};
