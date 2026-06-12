// M2 golden：12 对合成 fixture（中文名/多级 heading/跳级/代码块伪标题/未闭合 fence/
// frontmatter/无标题/单行/空文件/标题密集/大文件/规范名形态）对照。
// golden 由 Python 原版 md_to_tree 生成（scripts/gen-synthetic-fixtures.py，参数复刻
// 生产事实格式），测试方为 TS mdToTree——跨实现对照。差异 = bug，不许"差不多"。
//
// 历史验证记录（真实语料，local-only）：4005 个 vault 源文件中 2319 个未漂移源
// 100% 逐字段全等（2026-06-11，scripts/compare-golden.ts）。真实语料 fixture 在
// 已 gitignore 的 test/fixtures-local/，设 CANOPY_LOCAL_FIXTURES=1 时附加运行。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mdToTree } from "../src/core/tree.js";

const here = dirname(fileURLToPath(import.meta.url));
const mdDir = join(here, "fixtures/md");
const goldenDir = join(here, "fixtures/golden");
const localMdDir = join(here, "fixtures-local/md");
const localGoldenDir = join(here, "fixtures-local/golden");

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

function goldenSuite(name: string, md: string, golden: string): void {
  describe(name, () => {
    const fixtures = readdirSync(md).filter((f) => f.endsWith(".md"));
    for (const mdFile of fixtures) {
      it(mdFile, () => {
        const content = readFileSync(join(md, mdFile), "utf-8");
        const goldenRaw = JSON.parse(
          readFileSync(join(golden, mdFile.replace(/\.md$/, "_structure.json")), "utf-8"),
        ) as { doc_name: string };
        // doc_name 由调用方（indexing）从源路径取 basename，core 只透传——以 golden 自带值喂入
        const mine = mdToTree(content, { docName: goldenRaw.doc_name, withText: true });
        const expected = stripSummaries(goldenRaw);
        assertDeepEqualOrdered(JSON.parse(JSON.stringify(mine)), expected, "$");
      });
    }
  });
}

describe("core golden：mdToTree 与 Python 原版产物逐字段一致（去 summary 后）", () => {
  it("合成 fixture 数量正确", () => {
    expect(readdirSync(mdDir).filter((f) => f.endsWith(".md")).length).toBe(12);
  });
});
goldenSuite("core golden：合成 fixture（Python md_to_tree 生成）", mdDir, goldenDir);

// 真实语料对照：local-only。环境变量门控 + 目录存在才跑（CI/外部贡献者自动跳过）。
if (process.env["CANOPY_LOCAL_FIXTURES"] === "1" && existsSync(localMdDir)) {
  goldenSuite("core golden：真实语料 fixture（local-only）", localMdDir, localGoldenDir);
}
