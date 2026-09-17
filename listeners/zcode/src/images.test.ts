import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNormalEvent, type AttachmentEvent } from "@slopwatch/events";
import {
  captureToolResultImages,
  captureUserMessageImages,
  imageMarker,
  sniffImageMime,
  type ImageCapture,
} from "./images";

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const bytes = (head: Buffer, seed: number): Buffer =>
  Buffer.concat([head, Buffer.from([seed, seed, seed])]);

const captureWith = (files: Map<string, Buffer>): ImageCapture => ({
  sessionId: "sess_demo",
  occurredAt: "2026-09-17T00:00:00.000Z",
  origin: "user_message",
  seen: new Set<string>(),
  attachments: [],
  readImage: (path) => files.get(path) ?? null,
});

describe("sniffImageMime", () => {
  test("trusts the bytes, not the rollout's labels", () => {
    expect(sniffImageMime(bytes(PNG_HEAD, 1))).toBe("image/png");
    expect(sniffImageMime(bytes(JPEG_HEAD, 1))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from("GIF89a…."))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("RIFF1234WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("plain text"))).toBeNull();
  });
});

describe("captureUserMessageImages", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopwatch-images-"));
  const pngPath = join(dir, "image-a.png");
  const jpegPath = join(dir, "image-b.jpg");
  writeFileSync(pngPath, bytes(PNG_HEAD, 1));
  writeFileSync(jpegPath, bytes(JPEG_HEAD, 2));

  test("rewrites placeholders to markers and ships the bytes", () => {
    const capture = captureWith(
      new Map([
        [pngPath, bytes(PNG_HEAD, 1)],
        [jpegPath, bytes(JPEG_HEAD, 2)],
      ]),
    );
    const text = `bug report [Image: source: ${pngPath}] and [Image: source: ${jpegPath}]`;
    const { text: rewritten, refs } = captureUserMessageImages(
      text,
      [],
      capture,
    );

    expect(rewritten).toBe("bug report [image #1] and [image #2]");
    expect(refs.map((r) => r.n)).toEqual([1, 2]);
    expect(capture.attachments.length).toBe(2);
    for (const event of capture.attachments) {
      expect(isNormalEvent(event)).toBe(true);
      expect(event.origin).toBe("user_message");
      expect(event.mime).toMatch(/^image\/(png|jpeg)$/);
    }
  });

  test("one placeholder per file, even when repeated in the text", () => {
    const capture = captureWith(new Map([[pngPath, bytes(PNG_HEAD, 1)]]));
    const text = `[Image: source: ${pngPath}] then [Image: source: ${pngPath}] again`;
    const { text: rewritten, refs } = captureUserMessageImages(
      text,
      [],
      capture,
    );
    expect(rewritten).toBe("[image #1] then [image #1] again");
    expect(refs).toHaveLength(1);
    expect(capture.attachments).toHaveLength(1);
  });

  test("an unreadable image keeps its placeholder (dashboard shows not-archived)", () => {
    const capture = captureWith(new Map());
    const text = `[Image: source: C:\\pruned\\image-x.png]`;
    const { text: rewritten, refs } = captureUserMessageImages(
      text,
      [],
      capture,
    );
    expect(rewritten).toBe(text);
    expect(refs).toHaveLength(0);
    expect(capture.attachments).toHaveLength(0);
  });

  test("image blocks without a text placeholder land as trailing refs", () => {
    const capture = captureWith(new Map([[pngPath, bytes(PNG_HEAD, 9)]]));
    const { text: rewritten, refs } = captureUserMessageImages(
      "",
      [pngPath],
      capture,
    );
    expect(rewritten).toBe("");
    expect(refs.map((r) => r.n)).toEqual([1]);
  });

  test("history re-echoes skip re-upload but keep their ref", () => {
    const files = new Map([[pngPath, bytes(PNG_HEAD, 1)]]);
    const first = captureWith(files);
    captureUserMessageImages(`[Image: source: ${pngPath}]`, [], first);
    expect(first.attachments).toHaveLength(1);

    const second: ImageCapture = {
      ...first,
      attachments: [],
    };
    const { refs } = captureUserMessageImages(
      `[Image: source: ${pngPath}]`,
      [],
      second,
    );
    expect(refs.map((r) => r.n)).toEqual([1]);
    expect(second.attachments).toHaveLength(0); // sha already shipped
  });

  test("markers use the 1-based [image #n] form", () => {
    expect(imageMarker(3)).toBe("[image #3]");
  });
});

describe("captureToolResultImages", () => {
  test("collects shas from image blocks in a tool message", () => {
    const shotPath = "C:\\cache\\shot.png";
    const capture = captureWith(new Map([[shotPath, bytes(PNG_HEAD, 5)]]));
    const content = [
      { type: "text", text: "screenshot attached" },
      {
        type: "image",
        mediaType: "image/jpeg",
        dataUrl: "[dataUrl omitted from model-io: image/png, 100 chars]",
        source: { kind: "inline", path: shotPath },
      },
    ];
    const shas = captureToolResultImages(content, {
      ...capture,
      origin: "tool_result",
    });
    expect(shas).toHaveLength(1);
    expect(capture.attachments[0]!.origin).toBe("tool_result");
  });

  test("tool messages without images yield nothing", () => {
    const capture = captureWith(new Map());
    expect(
      captureToolResultImages([{ type: "text", text: "ok" }], {
        ...capture,
        origin: "tool_result",
      }),
    ).toEqual([]);
  });
});
