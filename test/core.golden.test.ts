// M2 golden：16 个代表性真实产物（中文名、嵌套目录、代码块重、大文件）对照。
// fixture 采自 molly.pageindex results/RPG 与 vault 快照中「源未漂移」（line_count 相等）
// 的配对；全量验证记录：4005 个源文件中 2319 个未漂移源 100% 逐字段全等（2026-06-11，
// scripts/compare-golden.ts）。差异 = bug，不许"差不多"。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mdToTree } from "../src/core/tree.js";

const here = dirname(fileURLToPath(import.meta.url));
const mdDir = join(here, "fixtures/md");
const goldenDir = join(here, "fixtures/golden");

/** 递归去掉 summary/prefix_summary（LLM 字段，core 不产）。保持其余键序。 */
function stripSummaries(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSummaries);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "summary" || k === "prefix_summary") continue;
      out[k] = stripSummaries(v);
    }
    return out;
  }
  return node;
}

/** 深比较含键序（产物字节兼容的前提是键序一致）。 */
function assertDeepEqualOrdered(actual: unknown, expected: unknown, path: string): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, path).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      assertDeepEqualOrdered((actual as unknown[])[i], expected[i], `${path}[${i}]`);
    }
    return;
  }
  if (expected && typeof expected === "object") {
    expect(Object.keys(actual as object).join(","), `${path} 键序`).toBe(
      Object.keys(expected as object).join(","),
    );
    for (const k of Object.keys(expected as object)) {
      assertDeepEqualOrdered(
        (actual as Record<string, unknown>)[k],
        (expected as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
    }
    return;
  }
  expect(actual, path).toBe(expected);
}

describe("core golden：mdToTree 与既有产物逐字段一致（去 summary 后）", () => {
  const fixtures = readdirSync(mdDir).filter((f) => f.endsWith(".md"));
  it("fixture 数量正确", () => {
    expect(fixtures.length).toBe(16);
  });

  for (const mdFile of fixtures) {
    it(mdFile, () => {
      const content = readFileSync(join(mdDir, mdFile), "utf-8");
      const goldenRaw = JSON.parse(
        readFileSync(join(goldenDir, mdFile.replace(/\.md$/, "_structure.json")), "utf-8"),
      ) as { doc_name: string };
      // doc_name 由调用方（indexing）从源路径取 basename，core 只透传——以 golden 自带值喂入
      const mine = mdToTree(content, { docName: goldenRaw.doc_name, withText: true });
      const golden = stripSummaries(goldenRaw);
      assertDeepEqualOrdered(JSON.parse(JSON.stringify(mine)), golden, "$");
    });
  }
});
