import { describe, expect, test } from "bun:test";
import { clock, fmtCost, fmtDuration, fmtTokens, shortId } from "./format";

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

describe("fmtCost", () => {
  test("sub-dollar amounts keep four decimals", () => {
    expect(fmtCost(0)).toBe("$0.0000");
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
