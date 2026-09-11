import { describe, expect, test } from "bun:test";
import { sparklinePoints } from "./sparkline";

describe("sparklinePoints", () => {
  test("empty series renders no points", () => {
    expect(sparklinePoints([], 96, 24)).toBe("");
  });

  test("all-zero series draws a flat baseline", () => {
    expect(sparklinePoints([0, 0, 0], 40, 10)).toBe(
      "1.0,9.0 20.0,9.0 39.0,9.0",
    );
  });

  test("the peak touches the top padding and zeros sit on the baseline", () => {
    const points = sparklinePoints([0, 10, 5], 40, 10);
    const [first, peak, last] = points.split(" ");
    expect(first).toBe("1.0,9.0");
    expect(peak).toBe("20.0,1.0");
    expect(last).toBe("39.0,5.0");
  });

  test("a single value collapses to one leftmost point", () => {
    expect(sparklinePoints([7], 40, 10)).toBe("1.0,1.0");
  });
});
