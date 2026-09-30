import { describe, expect, test } from "bun:test";
import { repairFlatMarkdown } from "./flat-markdown";

// Legacy turns were captured flattened: one line, no newlines, so block
// syntax (### headings, GFM tables) cannot parse. The repair re-linearizes
// exactly those two patterns and must leave everything else byte-identical.

describe("repairFlatMarkdown", () => {
  test("newline-carrying text is returned untouched", () => {
    const src = "line one\nline two\n\n### heading\n| a | b |\n|---|---|\n";
    expect(repairFlatMarkdown(src)).toBe(src);
  });

  test("plain prose without block syntax is returned untouched", () => {
    const src = "just a plain sentence, no markdown structure at all.";
    expect(repairFlatMarkdown(src)).toBe(src);
  });

  test("a heading run mid-line starts a new block, C# stays inline", () => {
    expect(repairFlatMarkdown("done. ### packages/ — 21 files")).toBe(
      "done.\n\n### packages/ — 21 files",
    );
    expect(repairFlatMarkdown("in C# 5 the compiler does X")).toBe(
      "in C# 5 the compiler does X",
    );
    expect(repairFlatMarkdown("a ## b and # c stay inline")).toBe(
      "a ## b and # c stay inline",
    );
  });

  test("a flattened table rebuilds header, delimiter, and rows", () => {
    const src =
      "prose head | 子包 | 测试文件数 | |---|---| | cli | 7 | | zcode | 5 | tail prose";
    expect(repairFlatMarkdown(src)).toBe(
      "prose head \n| 子包 | 测试文件数 |\n| --- | --- |\n| cli | 7 |\n| zcode | 5 |\n tail prose",
    );
  });

  test("a flattened table followed by a heading stops at the heading", () => {
    const src = "| 子包 | 数 | |---|---| | cli | 7 | ### 总结 done";
    expect(repairFlatMarkdown(src)).toBe(
      "| 子包 | 数 |\n| --- | --- |\n| cli | 7 |\n\n### 总结 done",
    );
  });

  test("an incomplete table is left alone", () => {
    // dashes but no complete data row
    const src = "text | a | b | --- | --- | and no data row follows";
    expect(repairFlatMarkdown(src)).toBe(src);
  });

  test("a lone dash cell next to prose is not a table", () => {
    const src = "text | --- | more text but no table here";
    expect(repairFlatMarkdown(src)).toBe(src);
  });

  test("a real captured report relinearizes end to end", () => {
    const src =
      "## 测试文件分布统计报告 **统计范围**:`D:\\studySpace\\slopwatch` 仓库中 `packages/` 与 `listeners/` 两个目录下的 `*.test.ts` / `*.test.tsx` 文件。 ### packages/ — 共 21 个测试文件(6 个子包) | 子包 | 测试文件数 | |---|---| | `packages/cli` | 7(detect, install, login, pause, status, uninstall, verify) | | `packages/listener-shared` | 5(liveness, tail, json-file, cursor, live-listener) | ### listeners/ — 共 24 个测试文件(2 个子包) | 子包 | 测试文件数 | |---|---| | `listeners/claude-code` | 13(index, install) | | `listeners/zcode` | 11(install, live) | ### 总结 listeners/ 共 24 个,略多于 packages/ 的 21 个。";
    const out = repairFlatMarkdown(src);
    // the h2 no longer swallows the report: every block sits on its own line
    expect(out.split("\n")).toHaveLength(15);
    expect(out).toContain(
      "## 测试文件分布统计报告 **统计范围**:`D:\\studySpace\\slopwatch`",
    );
    expect(out).toContain("| 子包 | 测试文件数 |\n| --- | --- |");
    expect(out).toContain(
      "| `packages/cli` | 7(detect, install, login, pause, status, uninstall, verify) |",
    );
    expect(out).toContain("| `listeners/zcode` | 11(install, live) |");
    expect(out.trimEnd().endsWith("。")).toBe(true);
  });
});
