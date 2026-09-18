import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ATTACHMENT_MAX_BYTES,
  FILE_MAX_BYTES,
  isNormalEvent,
  joinUrl,
  SCHEMA_VERSION,
  sendEvents,
  verifyAttachment,
  type AttachmentEvent,
  type ModelRequestEvent,
  type NormalEvent,
  type SessionEndEvent,
  type SessionStartEvent,
  type SessionSummaryEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type TurnEndEvent,
  type TurnStartEvent,
} from "./index";

const base = {
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: "sess-1",
  occurred_at: "2026-09-09T10:00:00.000Z",
} as const;

const sessionStart: SessionStartEvent = {
  ...base,
  kind: "session",
  event: "start",
  cwd: "D:\\work\\demo",
  hostname: "DEV-01",
  git_remote: "https://example.com/org/repo.git",
};

const sessionEnd: SessionEndEvent = {
  ...base,
  kind: "session",
  event: "end",
  reason: "idle-timeout",
};

const turnStart: TurnStartEvent = {
  ...base,
  kind: "turn",
  event: "start",
  turn_id: "turn-1",
  user_message: "fix the flaky test",
};

const turnEnd: TurnEndEvent = {
  ...base,
  kind: "turn",
  event: "end",
  turn_id: "turn-1",
  usage: { input_tokens: 1200, output_tokens: 340, cache_read_tokens: 800 },
};

const modelRequest: ModelRequestEvent = {
  ...base,
  kind: "model_request",
  request_id: "req-1",
  turn_id: "turn-1",
  provider: "builtin:bigmodel-coding-plan",
  model: "GLM-5.3-Flash",
  duration_ms: 3640,
  attempt: 1,
};

const toolCall: ToolCallEvent = {
  ...base,
  kind: "tool",
  event: "call",
  tool_call_id: "tc-1",
  tool: "Bash",
  args: { command: "bun test" },
};

const toolResult: ToolResultEvent = {
  ...base,
  kind: "tool",
  event: "result",
  tool_call_id: "tc-1",
  tool: "Bash",
  duration_ms: 210,
  ok: true,
};

const sessionSummary: SessionSummaryEvent = {
  ...base,
  kind: "session",
  event: "summary",
  body: "Implemented the slopwatch install flow; all tests green.",
  model: "glm-4",
};

/** Real PNG-headed bytes so mime/size/hash all cohere. */
const pngBytes = (seed: number): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([seed, seed, seed]),
  ]);

const attachment: AttachmentEvent = (() => {
  const bytes = pngBytes(1);
  return {
    ...base,
    kind: "attachment",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mime: "image/png",
    size: bytes.length,
    data: bytes.toString("base64"),
    origin: "user_message",
  };
})();

describe("NormalEvent v0 schema", () => {
  test("accepts every event variant", () => {
    const events: NormalEvent[] = [
      sessionStart,
      sessionEnd,
      sessionSummary,
      turnStart,
      turnEnd,
      modelRequest,
      toolCall,
      toolResult,
      attachment,
    ];
    for (const event of events) {
      expect(isNormalEvent(event)).toBe(true);
    }
  });

  test("accepts image refs on turn:start and tool results", () => {
    expect(
      isNormalEvent({
        ...turnStart,
        user_message: "look [image #1]",
        images: [{ n: 1, sha256: attachment.sha256, size: attachment.size }],
      }),
    ).toBe(true);
    expect(isNormalEvent({ ...toolResult, images: [attachment.sha256] })).toBe(
      true,
    );
  });

  test("rejects malformed image refs", () => {
    expect(
      isNormalEvent({
        ...turnStart,
        images: [{ n: 0, sha256: "ab".repeat(32) }],
      }),
    ).toBe(false); // n is 1-based
    expect(
      isNormalEvent({
        ...turnStart,
        images: [{ n: 1, sha256: "zz".repeat(32) }],
      }),
    ).toBe(false); // not hex
    expect(
      isNormalEvent({
        ...turnStart,
        images: Array.from({ length: 21 }, (_, i) => ({
          n: i + 1,
          sha256: "ab".repeat(32),
        })),
      }),
    ).toBe(false); // over the ref cap
    expect(isNormalEvent({ ...toolResult, images: ["nope"] })).toBe(false);
  });

  test("accepts any non-empty agent string — never a closed enum", () => {
    expect(isNormalEvent({ ...modelRequest, agent: "some-future-agent" })).toBe(
      true,
    );
  });

  test("accepts a subagent session linked to its parent", () => {
    expect(
      isNormalEvent({
        ...sessionStart,
        session_id: "sess-child",
        parent_session_id: "sess-1",
        spawned_by_turn_id: "turn-1",
      }),
    ).toBe(true);
  });

  test("accepts session meta events (title / task preview), rejects empty ones", () => {
    expect(
      isNormalEvent({
        ...base,
        kind: "session",
        event: "meta",
        title: "介绍一下 slopwatch",
      }),
    ).toBe(true);
    expect(
      isNormalEvent({
        ...base,
        kind: "session",
        event: "meta",
        task_preview: "fix the flaky test",
      }),
    ).toBe(true);
    expect(
      isNormalEvent({ ...base, kind: "session", event: "meta", title: "" }),
    ).toBe(false);
    expect(isNormalEvent({ ...base, kind: "session", event: "meta" })).toBe(
      false,
    );
  });

  test("accepts session summary events (body + model), rejects empty ones", () => {
    expect(isNormalEvent(sessionSummary)).toBe(true);
    expect(isNormalEvent({ ...sessionSummary, body: "" })).toBe(false);
    expect(isNormalEvent({ ...sessionSummary, model: "" })).toBe(false);
    expect(
      isNormalEvent({ ...sessionSummary, model: undefined as never }),
    ).toBe(false);
  });

  test("summary usage is optional but strictly shaped when present", () => {
    expect(
      isNormalEvent({
        ...sessionSummary,
        usage: { input_tokens: 10, output_tokens: 2, reasoning_tokens: 1 },
      }),
    ).toBe(true);
    expect(isNormalEvent({ ...sessionSummary, usage: {} })).toBe(true);
    expect(
      isNormalEvent({ ...sessionSummary, usage: { input_tokens: -1 } }),
    ).toBe(false);
    expect(
      isNormalEvent({ ...sessionSummary, usage: { total_tokens: 10 } }),
    ).toBe(false);
    expect(isNormalEvent({ ...sessionSummary, usage: 12 })).toBe(false);
  });

  test("rejects envelope violations", () => {
    const bad = (
      patch: (e: SessionStartEvent) => Partial<SessionStartEvent>,
    ) => {
      const merged = { ...sessionStart, ...patch(sessionStart) };
      return isNormalEvent(merged);
    };
    expect(bad(({ agent: _agent, ...rest }) => ({ ...rest, agent: "" }))).toBe(
      false,
    );
    expect(
      bad(({ session_id: _s, ...rest }) => ({ ...rest, session_id: "" })),
    ).toBe(false);
    expect(bad((e) => ({ ...e, schema_version: 99 as never }))).toBe(false);
    expect(bad((e) => ({ ...e, occurred_at: "not-a-date" }))).toBe(false);
    expect(isNormalEvent(null)).toBe(false);
    expect(isNormalEvent("session")).toBe(false);
    expect(isNormalEvent([sessionStart])).toBe(false);
  });

  test("rejects variant violations", () => {
    // unknown kind
    expect(isNormalEvent({ ...base, kind: "message", event: "start" })).toBe(
      false,
    );
    // session without an event discriminator
    expect(isNormalEvent({ ...sessionStart, event: undefined })).toBe(false);
    // session.start missing its dimension fields (decision 14)
    expect(isNormalEvent({ ...sessionStart, hostname: "" })).toBe(false);
    expect(isNormalEvent({ ...sessionStart, cwd: "" })).toBe(false);
    // turn without turn_id
    expect(isNormalEvent({ ...turnStart, turn_id: "" })).toBe(false);
    // model_request missing provider/model
    expect(isNormalEvent({ ...modelRequest, provider: "" })).toBe(false);
    expect(isNormalEvent({ ...modelRequest, model: "" })).toBe(false);
    // negative duration
    expect(isNormalEvent({ ...modelRequest, duration_ms: -1 })).toBe(false);
    // unknown usage key / negative token count
    expect(isNormalEvent({ ...turnEnd, usage: { tokens: 5 } as never })).toBe(
      false,
    );
    expect(isNormalEvent({ ...turnEnd, usage: { input_tokens: -5 } })).toBe(
      false,
    );
    // tool events must be pairable
    expect(isNormalEvent({ ...toolCall, tool_call_id: "" })).toBe(false);
    expect(isNormalEvent({ ...toolResult, ok: "yes" as never })).toBe(false);
  });

  test("model_request response_text is optional but must be non-empty", () => {
    expect(isNormalEvent(modelRequest)).toBe(true);
    expect(
      isNormalEvent({ ...modelRequest, response_text: "Fixed — tests pass." }),
    ).toBe(true);
    expect(isNormalEvent({ ...modelRequest, response_text: "" })).toBe(false);
  });
});

describe("attachment events (captured image bytes)", () => {
  test("verifyAttachment accepts a coherent payload", () => {
    expect(verifyAttachment(attachment)).toBe(true);
  });

  test("verifyAttachment rejects a payload that does not match its hash/size", () => {
    const bytes = pngBytes(2);
    const other = pngBytes(3);
    expect(
      verifyAttachment({
        ...attachment,
        data: bytes.toString("base64"),
        sha256: attachment.sha256,
      }),
    ).toBe(false); // different bytes, claimed hash kept
    expect(
      verifyAttachment({
        ...attachment,
        data: bytes.toString("base64"),
        size: bytes.length + 1,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    ).toBe(false); // size lies
  });

  test("rejects structural violations", () => {
    expect(isNormalEvent({ ...attachment, sha256: "short" })).toBe(false);
    expect(isNormalEvent({ ...attachment, mime: "image/svg+xml" })).toBe(false);
    expect(isNormalEvent({ ...attachment, size: 0 })).toBe(false);
    expect(
      isNormalEvent({ ...attachment, size: ATTACHMENT_MAX_BYTES + 1 }),
    ).toBe(false);
    expect(isNormalEvent({ ...attachment, data: "" })).toBe(false);
    expect(isNormalEvent({ ...attachment, data: "not base64!!" })).toBe(false);
    expect(isNormalEvent({ ...attachment, origin: "vibes" })).toBe(false);
    expect(isNormalEvent({ ...attachment, kind: "model_request" })).toBe(false);
  });

  test("oversized data strings fail before decode", () => {
    const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 16, 7).toString("base64");
    expect(
      isNormalEvent({
        ...attachment,
        data: big,
        size: ATTACHMENT_MAX_BYTES + 12,
      }),
    ).toBe(false);
  });
});

describe("attachment events (captured file bytes)", () => {
  const pdf = (size: number): Buffer =>
    Buffer.concat([Buffer.from("%PDF-1.5\n"), Buffer.alloc(size - 9, 5)]);
  const fileAttachment = (bytes: Buffer, mime = "application/pdf") => ({
    ...base,
    kind: "attachment",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mime,
    size: bytes.length,
    data: bytes.toString("base64"),
    origin: "user_message",
  });

  test("accepts a coherent pdf payload of any accepted file mime", () => {
    expect(isNormalEvent(fileAttachment(pdf(4096)))).toBe(true);
    expect(isNormalEvent(fileAttachment(pdf(4096), "application/zip"))).toBe(
      true,
    );
    expect(isNormalEvent(fileAttachment(pdf(4096), "video/mp4"))).toBe(true);
    expect(
      isNormalEvent(fileAttachment(pdf(4096), "application/octet-stream")),
    ).toBe(true);
    expect(
      isNormalEvent(
        fileAttachment(
          pdf(4096),
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
      ),
    ).toBe(true);
  });

  test("rejects executable-ish mimes the serve route would emit verbatim", () => {
    expect(isNormalEvent(fileAttachment(pdf(4096), "text/html"))).toBe(false);
    expect(isNormalEvent(fileAttachment(pdf(4096), "image/svg+xml"))).toBe(
      false,
    );
    expect(
      isNormalEvent(fileAttachment(pdf(4096), "application/xhtml+xml")),
    ).toBe(false);
  });

  test("files get the 10 MiB cap, images keep 4 MiB", () => {
    const fileBytes = pdf(FILE_MAX_BYTES);
    const fileEvent = fileAttachment(fileBytes);
    expect(isNormalEvent(fileEvent)).toBe(true);
    expect(isNormalEvent({ ...fileEvent, size: fileBytes.length + 1 })).toBe(
      false,
    );
    expect(isNormalEvent(fileAttachment(pdf(FILE_MAX_BYTES + 1)))).toBe(false);
    const imageBytes = Buffer.alloc(ATTACHMENT_MAX_BYTES, 7);
    expect(
      isNormalEvent({
        ...attachment,
        size: ATTACHMENT_MAX_BYTES,
        data: imageBytes.toString("base64"),
        sha256: createHash("sha256").update(imageBytes).digest("hex"),
      }),
    ).toBe(true); // image cap unchanged at 4 MiB
  });

  test("verifyAttachment enforces the file cap too", () => {
    const bytes = pdf(1024);
    expect(
      verifyAttachment({
        ...base,
        kind: "attachment",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mime: "application/pdf",
        size: bytes.length,
        data: bytes.toString("base64"),
        origin: "user_message",
      }),
    ).toBe(true);
  });

  test("turn:start accepts file refs and rejects malformed ones", () => {
    const fileSha = createHash("sha256").update("file-bytes").digest("hex");
    const files = [
      {
        n: 1,
        sha256: fileSha,
        size: 11,
        name: "spec.pdf",
        mime: "application/pdf",
      },
    ];
    expect(isNormalEvent({ ...turnStart, files })).toBe(true);
    expect(
      isNormalEvent({ ...turnStart, files: [{ ...files[0]!, size: -1 }] }),
    ).toBe(false);
    expect(
      isNormalEvent({ ...turnStart, files: [{ ...files[0]!, name: "" }] }),
    ).toBe(false);
    expect(
      isNormalEvent({
        ...turnStart,
        files: [{ ...files[0]!, mime: "text/html" }],
      }),
    ).toBe(true); // refs render only; the mime gate is on attachment events
    expect(
      isNormalEvent({
        ...turnStart,
        files: Array.from({ length: 21 }, (_, i) => ({
          ...files[0]!,
          n: i + 1,
        })),
      }),
    ).toBe(false);
  });
});

describe("joinUrl", () => {
  test("strips trailing slashes and inserts exactly one separator", () => {
    expect(joinUrl("http://x/", "/v1")).toBe("http://x/v1");
    expect(joinUrl("http://x", "/v1")).toBe("http://x/v1");
    expect(joinUrl("http://x///", "/v1")).toBe("http://x/v1");
    expect(joinUrl("http://x/", "v1")).toBe("http://x/v1");
  });

  test("keeps any path prefix on the base", () => {
    expect(joinUrl("http://localhost:8787/base/", "/events")).toBe(
      "http://localhost:8787/base/events",
    );
    expect(joinUrl("https://llm.internal/v1", "/chat/completions")).toBe(
      "https://llm.internal/v1/chat/completions",
    );
  });
});

describe("sendEvents", () => {
  test("posts a versioned batch with bearer auth", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      captured = { url: String(url), init: init! };
      return new Response(null, { status: 202 });
    }) as typeof fetch;

    await sendEvents([sessionStart, modelRequest], {
      serverUrl: "http://localhost:8787/",
      token: "tok-1",
      fetchImpl,
    });

    expect(captured?.url).toBe("http://localhost:8787/events");
    expect(captured?.init.method).toBe("POST");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tok-1");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(captured?.init.body as string);
    expect(body.schema_version).toBe(SCHEMA_VERSION);
    expect(body.events).toHaveLength(2);
  });

  test("throws on server error (v0: caller drops — no retry)", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await expect(
      sendEvents([sessionEnd], {
        serverUrl: "http://localhost:8787",
        token: "tok-1",
        fetchImpl,
      }),
    ).rejects.toThrow("500");
  });
});
