import { describe, expect, test } from "bun:test";
import { isNormalEvent } from "@slopwatch/events";
import {
  captureInlineImages,
  inlineImageBlocks,
  sniffImageMime,
  usageOf,
} from "./images";
import { TINY_PNG_BASE64 } from "./fixtures/transcript-record";

const pngBlock = (data: string, mediaType = "image/png"): unknown => ({
  type: "image",
  source: { type: "base64", media_type: mediaType, data },
});

const capture = (
  sessionId = "sess_img",
): {
  seen: Set<string>;
  attachments: Parameters<typeof captureInlineImages>[1]["attachments"];
} => ({ seen: new Set<string>(), attachments: [] });

describe("inlineImageBlocks", () => {
  test("collects base64 source blocks, ignores other content", () => {
    const content = [
      { type: "text", text: "look" },
      pngBlock(TINY_PNG_BASE64),
      { type: "image", source: { type: "url", url: "https://x" } },
      { type: "tool_result", tool_use_id: "t" },
    ];
    expect(inlineImageBlocks(content)).toHaveLength(1);
    expect(inlineImageBlocks("just text")).toEqual([]);
    expect(inlineImageBlocks(undefined)).toEqual([]);
  });
});

describe("sniffImageMime", () => {
  test("trusts the bytes over the label", () => {
    const png = Buffer.from(TINY_PNG_BASE64, "base64");
    expect(sniffImageMime(png)).toBe("image/png");
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    );
    expect(sniffImageMime(Buffer.from("GIF89a..."))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("not an image"))).toBeNull();
  });
});

describe("captureInlineImages", () => {
  test("ships one attachment and a 1-based ref per distinct image", () => {
    const sink = capture();
    const { refs, shas } = captureInlineImages(
      [pngBlock(TINY_PNG_BASE64), pngBlock(TINY_PNG_BASE64)],
      {
        origin: "user_message",
        sessionId: "sess_img",
        occurredAt: "2026-09-29T09:00:00.000Z",
        ...sink,
      },
    );
    expect(sink.attachments).toHaveLength(1); // identical blocks dedupe
    expect(refs).toHaveLength(1);
    expect(refs[0]!.n).toBe(1);
    expect(refs[0]!.size).toBeGreaterThan(0);
    expect(shas).toHaveLength(1);
    expect(isNormalEvent(sink.attachments[0]!)).toBe(true);
  });

  test("a lying media_type is corrected by the bytes", () => {
    const sink = capture();
    captureInlineImages([pngBlock(TINY_PNG_BASE64, "image/jpeg")], {
      origin: "tool_result",
      sessionId: "sess_img",
      occurredAt: "2026-09-29T09:00:00.000Z",
      ...sink,
    });
    expect(sink.attachments[0]!.mime).toBe("image/png");
  });

  test("a junk payload labeled as an image is skipped, not shipped", () => {
    const sink = capture();
    const { refs, shas } = captureInlineImages(
      [pngBlock(Buffer.from("hello there").toString("base64"))],
      {
        origin: "user_message",
        sessionId: "sess_img",
        occurredAt: "2026-09-29T09:00:00.000Z",
        ...sink,
      },
    );
    expect(sink.attachments).toHaveLength(0);
    expect(refs).toHaveLength(0);
    expect(shas).toHaveLength(0);
  });

  test("re-captures of the same bytes dedupe through the seen set", () => {
    const sink = capture();
    const ctx = {
      origin: "tool_result" as const,
      sessionId: "sess_img",
      occurredAt: "2026-09-29T09:00:00.000Z",
      seen: sink.seen,
      attachments: sink.attachments,
    };
    captureInlineImages([pngBlock(TINY_PNG_BASE64)], ctx);
    captureInlineImages([pngBlock(TINY_PNG_BASE64)], ctx);
    expect(sink.attachments).toHaveLength(1);
  });
});

describe("usageOf", () => {
  test("maps transcript usage fields onto the wire names", () => {
    expect(
      usageOf({
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 4,
      }),
    ).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_tokens: 30,
      cache_write_tokens: 4,
    });
  });

  test("garbage yields null so the request ships without usage", () => {
    expect(usageOf(undefined)).toBeNull();
    expect(usageOf({})).toBeNull();
    expect(usageOf("nope")).toBeNull();
  });
});
