import { fmtTokens } from "../lib/format";
import type { WaterfallBar } from "../lib/waterfall";

/**
 * The hover title: the turn's label, then one line per non-zero token kind —
 * the founding question ("where did it go?") answered in one glance.
 */
const barTitle = (bar: WaterfallBar): string => {
  const lines = [
    `${bar.label} · ${fmtTokens(bar.total)} total`,
    `in ${fmtTokens(bar.inputTokens)}`,
    `out ${fmtTokens(bar.outputTokens)}`,
    `cache-read ${fmtTokens(bar.cacheReadTokens)}`,
    `cache-write ${fmtTokens(bar.cacheWriteTokens)}`,
  ];
  return lines.join("\n");
};

/** Bottom-up stack order inside a bar: input is the foundation, output on top. */
const SEGMENTS = [
  { key: "inputTokens", className: "wf-in" },
  { key: "cacheReadTokens", className: "wf-cache-read" },
  { key: "cacheWriteTokens", className: "wf-cache-write" },
  { key: "outputTokens", className: "wf-out" },
] as const satisfies readonly {
  key: keyof Omit<WaterfallBar, "turnId" | "label" | "total">;
  className: string;
}[];

/**
 * The session token waterfall (v3 decision 32): one column per turn in
 * first-appearance order, height proportional to that turn's burn, stacked
 * by token kind. A zero-usage turn still shows as a gap in the sequence —
 * its shape carries information. "(unattributed)" closes the strip when the
 * timeline left orphaned requests, so the total never lies.
 */
export const TokenWaterfall = ({ bars }: { bars: WaterfallBar[] }) => {
  const max = Math.max(...bars.map((bar) => bar.total), 1);
  return (
    <div
      className="waterfall"
      role="img"
      aria-label={`Token burn per turn: ${bars
        .map((bar) => `${bar.turnId} ${fmtTokens(bar.total)}`)
        .join(", ")}`}
    >
      {bars.map((bar, index) => (
        <div className="wf-col" key={`${bar.turnId}-${index}`}>
          <div
            className="wf-stack"
            title={barTitle(bar)}
            style={{ height: `${Math.max((bar.total / max) * 100, 1)}%` }}
          >
            {bar.total === 0 ? (
              <div className="wf-zero" />
            ) : (
              SEGMENTS.map((seg) => {
                const value = bar[seg.key];
                if (value === 0) return null;
                return (
                  <div
                    key={seg.key}
                    className={`wf-seg ${seg.className}`}
                    style={{ flexGrow: value }}
                  />
                );
              })
            )}
          </div>
          <span className="wf-tick">{index + 1}</span>
        </div>
      ))}
    </div>
  );
};
