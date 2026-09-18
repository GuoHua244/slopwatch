import { describe, expect, test } from "bun:test";
import {
  clock,
  fmtBytes,
  fmtCost,
  fmtDelta,
  fmtDuration,
  fmtTokens,
  shortId,
  sinceDuration,
  summarizeArgs,
} from "./format";

describe("fmtTokens", () => {
  test("small numbers stay bare", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(713)).toBe("713");
    expect(fmtTokens(999)).toBe("999");
  });

  test("thousands abbreviate to k", () => {
    expect(fmtTokens(1000)).toBe("1.0k");
    expect(fmtTokens(136384)).toBe("136.4k");
  });

  test("millions abbreviate to M", () => {
    expect(fmtTokens(1e6)).toBe("1.0M");
    expect(fmtTokens(2125000)).toBe("2.1M");
  });
});

describe("fmtBytes", () => {
  test("bytes stay bare with a unit", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
  });

  test("kilobytes and megabytes abbreviate", () => {
    expect(fmtBytes(513823)).toBe("513.8 KB");
    expect(fmtBytes(5242880)).toBe("5.2 MB");
  });
});

describe("fmtCost", () => {
  test("sub-dollar amounts keep four decimals; exact zero stays short", () => {
    expect(fmtCost(0)).toBe("$0");
    expect(fmtCost(0.0042)).toBe("$0.0042");
    expect(fmtCost(0.115)).toBe("$0.1150");
  });

  test("dollar-plus amounts round to cents", () => {
    expect(fmtCost(1)).toBe("$1.00");
    expect(fmtCost(12.345)).toBe("$12.35");
  });
});

describe("clock", () => {
  test("renders local HH:MM:SS", () => {
    const local = new Date(2026, 8, 9, 15, 26, 58);
    expect(clock(local.toISOString())).toBe("15:26:58");
  });
});

describe("fmtDuration", () => {
  test("sub-second shows raw ms", () => {
    expect(fmtDuration(0)).toBe("0ms");
    expect(fmtDuration(850)).toBe("850ms");
  });

  test("under a minute shows one decimal of seconds", () => {
    expect(fmtDuration(1000)).toBe("1.0s");
    expect(fmtDuration(49261)).toBe("49.3s");
  });

  test("a minute plus shows m ss", () => {
    expect(fmtDuration(60000)).toBe("1m00s");
    expect(fmtDuration(130000)).toBe("2m10s");
  });
});

describe("shortId", () => {
  test("strips the kind prefix and truncates", () => {
    expect(shortId("sess_ec0623ae-43fa-4eb6-9260-bdc5e4e2fc31")).toBe(
      "ec0623ae",
    );
    expect(shortId("turn_613df76b-7b4d")).toBe("613df76b");
    expect(shortId("plainid")).toBe("plainid");
  });
});

describe("summarizeArgs", () => {
  test("renders the first three entries as key=value pairs", () => {
    expect(summarizeArgs({ file_path: "a.ts", limit: 5 })).toBe(
      "file_path=a.ts limit=5",
    );
    expect(summarizeArgs({ a: "1", b: "2", c: "3", d: "4" })).toBe(
      "a=1 b=2 c=3",
    );
  });

  test("truncates long values", () => {
    const long = "x".repeat(60);
    expect(summarizeArgs({ command: long })).toBe(`command=${"x".repeat(39)}…`);
  });

  test("handles empty, primitive, and stringified values", () => {
    expect(summarizeArgs(undefined)).toBe("");
    expect(summarizeArgs({})).toBe("");
    expect(summarizeArgs("raw string")).toBe("raw string");
    expect(summarizeArgs({ nested: { a: 1 } })).toBe('nested={"a":1}');
  });
});

describe("fmtDelta", () => {
  test("no baseline renders a dash", () => {
    expect(fmtDelta(null)).toBe("—");
  });

  test("ratios render a colorless direction arrow", () => {
    expect(fmtDelta(0)).toBe("↑ 0%");
    expect(fmtDelta(0.2534)).toBe("↑ 25%");
    expect(fmtDelta(-0.2534)).toBe("↓ 25%");
  });
});

describe("sinceDuration", () => {
  const now = Date.parse("2026-09-15T12:00:00.000Z");
  test("minutes under an hour", () => {
    expect(sinceDuration("2026-09-15T11:40:00.000Z", now)).toBe("20m");
  });
  test("hours under two days", () => {
    expect(sinceDuration("2026-09-15T06:00:00.000Z", now)).toBe("6h");
  });
  test("days under two months", () => {
    expect(sinceDuration("2026-08-20T12:00:00.000Z", now)).toBe("26d");
  });
  test("months under two years", () => {
    expect(sinceDuration("2026-04-01T12:00:00.000Z", now)).toBe("5.5mo");
  });
  test("years beyond", () => {
    expect(sinceDuration("2024-01-01T12:00:00.000Z", now)).toBe("2.7y");
  });
  test("a future timestamp clamps to zero", () => {
    expect(sinceDuration("2026-09-15T12:30:00.000Z", now)).toBe("0m");
  });
});
