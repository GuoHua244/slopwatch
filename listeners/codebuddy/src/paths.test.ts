/**
 * Path tests. The crown jewel is the workspace hash: CodeBuddy addresses a
 * workspace by `md5(lower-cased Windows path)`, discovered by matching a real
 * directory name, which lets a listener find its own history — and its real
 * cwd — without trusting anything the hook says.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cwdForHash,
  conversationDir,
  conversationFromTranscriptPath,
  conversationIndexPath,
  historyRoots,
  latestConversation,
  messagePath,
  resolveSurfaces,
  usageLogPath,
  windowsKey,
  workspaceHash,
  workspaceIndexPath,
  workspaceMap,
  type HostRoots,
} from "./paths";
import {
  realHookPayload,
  REAL_CONVERSATION_ID,
  REAL_WORKSPACE_HASH,
  REAL_WORKSPACE_PATH,
} from "./fixtures/history-record";

describe("workspace hash", () => {
  test("md5 of the lower-cased Windows path matches the real directory name", () => {
    // the hook's session output proved this: md5("d:\\studySpace\\slopwatch")
    // is literally the directory CodeBuddy wrote history into
    expect(workspaceHash(REAL_WORKSPACE_PATH)).toBe(REAL_WORKSPACE_HASH);
  });

  test("separator and drive-case noise collapse onto one key", () => {
    expect(windowsKey(REAL_WORKSPACE_PATH)).toBe("d:\\studySpace\\slopwatch");
    // the same folder written the way the transcript mentions files…
    expect(workspaceHash("d:/studySpace/slopwatch")).toBe(REAL_WORKSPACE_HASH);
    // …and the way Windows reports a drive letter
    expect(workspaceHash("D:\\studySpace\\slopwatch")).toBe(
      REAL_WORKSPACE_HASH,
    );
    expect(workspaceHash(`${REAL_WORKSPACE_PATH}\\`)).toBe(REAL_WORKSPACE_HASH);
  });

  test("a different directory is a different workspace", () => {
    expect(workspaceHash("d:\\studySpace\\other")).not.toBe(
      REAL_WORKSPACE_HASH,
    );
  });
});

describe("conversationFromTranscriptPath", () => {
  test("splits the real hook transcript_path back into its coordinates", () => {
    const ref = conversationFromTranscriptPath(realHookPayload.transcript_path);
    expect(ref).not.toBeNull();
    expect(ref?.workspaceHash).toBe(REAL_WORKSPACE_HASH);
    expect(ref?.conversationId).toBe(REAL_CONVERSATION_ID);
    expect(ref?.root).toContain("CodeBuddyExtension");
  });

  test("a path with no history segment is refused", () => {
    expect(conversationFromTranscriptPath("C:\\tmp\\x.json")).toBeNull();
    expect(
      conversationFromTranscriptPath("C:\\x\\history\\only-one-segment"),
    ).toBeNull();
  });

  test("derived paths stay inside the conversation directory", () => {
    const ref = conversationFromTranscriptPath(
      realHookPayload.transcript_path,
    )!;
    expect(conversationIndexPath(ref).endsWith("index.json")).toBe(true);
    expect(
      messagePath(ref, "deadbeef").endsWith(join("messages", "deadbeef.json")),
    ).toBe(true);
    expect(conversationDir(ref)).toContain(REAL_CONVERSATION_ID);
    expect(workspaceIndexPath(ref)).toContain(REAL_WORKSPACE_HASH);
  });
});

// --- A synthetic host tree, laid out exactly like the real one ---------------

const tmp = mkdtempSync(join(tmpdir(), "slopwatch-codebuddy-paths-"));
const localAppData = join(tmp, "local");
const appData = join(tmp, "roaming");
const instance = "0d54d05f-44cd-4a97-9470-348b316b76e0";
const root = join(
  localAppData,
  "CodeBuddyExtension",
  "Data",
  instance,
  "CodeBuddyIDE",
  instance,
);
const wsDir = join(root, "history", REAL_WORKSPACE_HASH);
const convDir = join(wsDir, REAL_CONVERSATION_ID);
mkdirSync(join(convDir, "messages"), { recursive: true });
writeFileSync(join(convDir, "index.json"), "{}");
mkdirSync(join(wsDir, "older-conversation", "messages"), { recursive: true });
writeFileSync(join(wsDir, "older-conversation", "index.json"), "{}");

// the IDE's own workspace record — file URI → folder
mkdirSync(
  join(appData, "CodeBuddy CN", "User", "workspaceStorage", "11c52822"),
  { recursive: true },
);
writeFileSync(
  join(
    appData,
    "CodeBuddy CN",
    "User",
    "workspaceStorage",
    "11c52822",
    "workspace.json",
  ),
  `{\n  "folder": "file:///d%3A/studySpace/slopwatch"\n}`,
);

const stamp = "2026-10-08";
mkdirSync(
  join(localAppData, "CodeBuddyExtension", "Logs", "CodeBuddyIDE", stamp),
  { recursive: true },
);
writeFileSync(
  join(
    localAppData,
    "CodeBuddyExtension",
    "Logs",
    "CodeBuddyIDE",
    stamp,
    `slopwatch__${REAL_WORKSPACE_HASH}.log`,
  ),
  "",
);

const roots: HostRoots = { localAppData, appData };

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("host discovery", () => {
  test("history roots are found across instances", () => {
    expect(historyRoots(localAppData)).toContain(root);
  });

  test("the workspace record resolves the hash to a real cwd", () => {
    const map = workspaceMap(appData);
    expect(cwdForHash(map, REAL_WORKSPACE_HASH)).toBe(REAL_WORKSPACE_PATH);
    expect(cwdForHash(map, "nope")).toBeNull();
  });

  test("the usage log is found by its hash suffix", () => {
    expect(
      usageLogPath({
        localAppData,
        workspaceHash: REAL_WORKSPACE_HASH,
        date: new Date("2026-10-08T12:00:00"),
      }),
    ).toBe(
      join(
        localAppData,
        "CodeBuddyExtension",
        "Logs",
        "CodeBuddyIDE",
        stamp,
        `slopwatch__${REAL_WORKSPACE_HASH}.log`,
      ),
    );
    expect(
      usageLogPath({
        localAppData,
        workspaceHash: "absent",
        date: new Date("2026-10-08T12:00:00"),
      }),
    ).toBeNull();
  });

  test("the most recently written conversation is the running one", () => {
    utimesSync(
      join(wsDir, "older-conversation", "index.json"),
      new Date(1),
      new Date(1),
    );
    const ref = latestConversation(localAppData, REAL_WORKSPACE_HASH);
    expect(ref?.conversationId).toBe(REAL_CONVERSATION_ID);
    expect(latestConversation(localAppData, "absent")).toBeNull();
  });

  test("resolveSurfaces replaces the hook's bogus cwd with the real one", () => {
    const found = resolveSurfaces({
      transcriptPath: realHookPayload.transcript_path,
      roots,
      date: new Date("2026-10-08T12:00:00"),
    });
    // the hook said "D:\software\CodeBuddy CN" — the reverse map knows better
    expect(found?.cwd).toBe(REAL_WORKSPACE_PATH);
    expect(found?.ref.conversationId).toBe(REAL_CONVERSATION_ID);
    expect(found?.usageLog).toContain(`${REAL_WORKSPACE_HASH}.log`);
  });

  test("without a transcript_path the workspace's latest conversation is found", () => {
    const found = resolveSurfaces({ cwd: REAL_WORKSPACE_PATH, roots });
    expect(found?.ref.conversationId).toBe(REAL_CONVERSATION_ID);
    expect(found?.cwd).toBe(REAL_WORKSPACE_PATH);
  });
});
