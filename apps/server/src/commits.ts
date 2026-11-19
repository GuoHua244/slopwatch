/**
 * v3 decision 34: the session ↔ commit extractor. Generic string scanning
 * over the two fields the event contract carries for every listener — tool
 * call `args` (the command text) and the paired result's `raw` (the verbatim
 * agent record, where git's own output lives). No per-agent tool-name table:
 * any tool whose args embed a git-commit command triggers, whatever the
 * agent calls it.
 */

/**
 * A git-commit invocation anywhere in a command string: `git commit`, with
 * global flags between — bare dash flags (`--no-pager`), or the ones that
 * take an argument (`-C path`, `-c key=val`) — and a dry run excluded: it
 * produces nothing. A non-flag word before `commit` (as in `git rebase
 * commit`) is never a commit.
 */
const GIT_COMMIT =
  /(?:^|[;&|(]|\s)git(?:\s+(?:-C\s+\S+|-c\s+\S+|-\S+))*\s+commit(?:\s|$)/;

/** The subject: `-m`, `-M`, or `--message`, double- or single-quoted, or the
 * one bare word git would take (bare multi-word subjects need the quotes). */
const COMMIT_SUBJECT =
  /(?:^|\s)(?:-m|-M|--message)\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s'"][^\s]*))/;

/** Git's own success output: `[branch sha] subject`, with the `(root-commit)`
 * annotation git sometimes inserts. */
const COMMIT_OUTPUT =
  /\[([^\s\]]+)(?:\s+\([^)]*\))?\s+([0-9a-f]{7,40})\]\s*([^\n\r"\\]*)/;

/** Storage cap for one subject — commit subjects run long, rows should not. */
const SUBJECT_MAX = 200;

/**
 * Every string embedded in a tool-call args value — the shell commands ride
 * in whatever field the agent's tool schema uses (`command`, `cmd`, …), so
 * the scan collects them all, depth- and count-capped against pathological
 * args.
 */
export const stringsFromArgs = (args: unknown): string[] => {
  const out: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (out.length >= 20 || depth > 5) return;
    if (typeof value === "string") {
      out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>))
        visit(item, depth + 1);
    }
  };
  visit(args, 0);
  return out;
};

/** Whether one command string invokes git commit (excluding dry runs). */
export const isCommitCall = (command: string): boolean =>
  command.includes("--dry-run") === false && GIT_COMMIT.test(command);

/**
 * The commit command a call carries, if any — the trigger plus the source
 * the command-line subject is lifted from. Null when the call is not a
 * commit.
 */
export const commitCommandFromArgs = (args: unknown): string | null => {
  for (const candidate of stringsFromArgs(args)) {
    if (isCommitCall(candidate)) return candidate;
  }
  return null;
};

/** The `-m`/`--message` subject of a commit command, null when it had none. */
export const commitSubjectFromCommand = (command: string): string | null => {
  // `--message=x` and `--message x` are the same flag to git; normalize so
  // one pattern covers both spellings.
  const normalized = command.replace(/--message=/g, "--message ");
  const match = COMMIT_SUBJECT.exec(normalized);
  const subject = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "")
    .replace(/\\(["'])/g, "$1")
    .trim();
  return subject === "" ? null : subject.slice(0, SUBJECT_MAX);
};

/**
 * Git's commit output mined from a result's raw — the verbatim agent record
 * the contract retains for fidelity. Stringified wholesale, so wherever the
 * output sits in the record (content block, nested field), the pattern
 * finds it. Null when the raw carries no git output, which is the contract's
 * honest degradation: the subject from the command line still links.
 */
export const commitOutputFromRaw = (
  raw: unknown,
): { branch: string; sha: string; subject: string | null } | null => {
  if (raw === undefined || raw === null) return null;
  const text =
    typeof raw === "string"
      ? raw
      : JSON.stringify(raw, (_k, v) =>
          typeof v === "string" ? v.replaceAll("\\n", "\n") : v,
        );
  if (text === undefined) return null;
  const match = COMMIT_OUTPUT.exec(text);
  if (!match) return null;
  const subject = match[3]?.trim().slice(0, SUBJECT_MAX) ?? "";
  return {
    branch: match[1]!,
    sha: match[2]!,
    subject: subject === "" ? null : subject,
  };
};
