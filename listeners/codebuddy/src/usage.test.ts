/**
 * Usage tests, driving verbatim agent-log lines. Every other listener finds
 * token counts inside its transcript; CodeBuddy does not, so this parser is
 * load-bearing for any claim this listener makes about spend.
 */
import { describe, expect, test } from "bun:test";
import { indexUsageByMessage, usageFromLogText, USAGE_GRACE_MS } from "./usage";
import { realUsageLogLines } from "./fixtures/history-record";

describe("usageFromLogText", () => {
  test("reads both real lines and joins the duration from the metrics line", () => {
    const records = usageFromLogText(realUsageLogLines.join("\n"));
    expect(records).toHaveLength(2);
    const first = records[0]!;
    expect(first.messageId).toBe("d0e251f82b41488ca2d456dd4b18e7fe");
    expect(first.requestId).toBe("00592a8d23944ff7b9422c179366547d");
    expect(first.step).toBe(1);
    expect(first.durationMs).toBe(4381);
    expect(first.usage).toEqual({
      input_tokens: 12633,
      output_tokens: 59,
      cache_read_tokens: 4224,
      cache_write_tokens: 0,
      reasoning_tokens: 59,
    });
    // the log clock is the machine's local time — assert the conversion to
    // UTC rather than a hard-coded offset that would break on another box
    expect(first.occurredAt).toBe(
      new Date("2026-10-08T18:38:04.276").toISOString(),
    );
  });

  test("maps maybe-reasoning tokens and ignores unmappable fields", () => {
    const records = usageFromLogText(realUsageLogLines[2]!);
    expect(records[0]?.usage).toEqual({
      input_tokens: 15714,
      output_tokens: 71,
      cache_read_tokens: 12608,
      cache_write_tokens: 0,
      reasoning_tokens: 12,
    });
    // cachedMissTokens / credit / lastTokens have no slot in TokenUsage and
    // must never be smuggled in — the server rejects unknown usage keys
    expect(Object.keys(records[0]!.usage).sort()).toEqual([
      "cache_read_tokens",
      "cache_write_tokens",
      "input_tokens",
      "output_tokens",
      "reasoning_tokens",
    ]);
  });

  test("lines without usage, or with a truncated usage object, yield nothing", () => {
    expect(
      usageFromLogText(
        "[2026/10/8 18:38:04.276] [Info] [BaseAgent:craft] [abc]  something else happened",
      ),
    ).toEqual([]);
    expect(
      usageFromLogText(
        '[2026/10/8 18:38:04.276] [Info] [BaseAgent:craft] [abc]  notifyStepEnd, step: 1, messageId: deadbeef, usage: {"inputToke',
      ),
    ).toEqual([]);
  });

  test("a usage block with no recognized counters is dropped", () => {
    const records = usageFromLogText(
      '[2026/10/8 18:38:04.276] [Info] [BaseAgent:craft] [abc]  notifyStepEnd, step: 3, messageId: aa, usage: {"credit":1}, x: false',
    );
    expect(records).toEqual([]);
  });

  test("negative or fractional counts never reach a bigint column", () => {
    const records = usageFromLogText(
      '[2026/10/8 18:38:04.276] [Info] [BaseAgent:craft] [abc]  notifyStepEnd, step: 3, messageId: aa, usage: {"inputTokens":1.5,"outputTokens":-3}',
    );
    expect(records[0]?.usage).toEqual({ input_tokens: 1 });
  });

  test("timestamp-less lines are ignored rather than dated now", () => {
    expect(
      usageFromLogText(
        'notifyStepEnd, step: 1, messageId: aa, usage: {"inputTokens":5}',
      ),
    ).toEqual([]);
  });

  test("indexUsageByMessage keys by message id, last write wins", () => {
    const map = indexUsageByMessage(
      usageFromLogText(realUsageLogLines.join("\n")),
    );
    expect([...map.keys()]).toEqual([
      "d0e251f82b41488ca2d456dd4b18e7fe",
      "f47957d9eb514aba9c91a6e0cbe0843b",
    ]);
    expect(map.get("f47957d9eb514aba9c91a6e0cbe0843b")?.durationMs).toBe(3021);
  });

  test("the grace window is bounded — missing counts must not stall evidence", () => {
    expect(USAGE_GRACE_MS).toBeLessThan(120_000);
    expect(USAGE_GRACE_MS).toBeGreaterThan(0);
  });
});
