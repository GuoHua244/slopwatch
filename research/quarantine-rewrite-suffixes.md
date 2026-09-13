# Quarantine finding: mid-record suffixes after a rollout rewrite

2026-09-14 diagnosis of quarantine rows #24-26 ("unparsable json",
2026-09-13 09:16-09:28, sessions `b25c1362` / `eb1c647c`). Recorded here so
the next operator who sees this shape knows it is a known artifact, not new
corruption.

## Shape

Each row is a **byte suffix of one legitimate `model_io` JSONL record**:

- it opens with the raw escaped content of the record's `response` field
  (review-report markdown — `\n\n# 结论先行...`),
- it ends with the record's real closing fields
  (`..."querySource":"main_turn","startedAt":...,"type":"model_io"}`),
- nothing in between is malformed — the prefix (up to and including
  `"response":"`) is simply missing.

## Mechanism

The live tail resumes each sidecar generation from the previous
generation's byte offset. ZCode rewrites rollout files across session
resumes (compaction/re-encode) without shrinking them below the old
offset, so the tail can resume **mid-record** in the rewritten file: the
first fragment read has no line boundary at its start, `JSON.parse` fails,
and decision 21's drift quarantine stores it verbatim. The shrink case
(`current < size`) is detected and resets the read; the same-or-larger
rewrite case is not detectable without a fingerprint, and reacting to it
by re-reading the whole file would re-emit every event as a duplicate
under a fresh `event_seq`.

## Disposition

- **Not data loss**: the record's content lives in the conversation, and
  the quarantine keeps the suffix byte-for-byte.
- The tailer documents the behavior (`packages/listener-shared/src/tail.ts`).
- A real fix is a resync protocol — fingerprint the file (size + head
  hash) in the cursor, and on rewrite re-read **with dedup** so re-reading
  cannot double-count turns. Deferred until rewrite frequency or volume
  makes the occasional quarantine row a real operational cost.
- For ops: quarantine rows of this shape (prose/mid-JSON start, valid
  record tail) are safe to acknowledge; rows whose content looks like real
  capture losses are the ones to investigate.
