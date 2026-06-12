// indexing 测试：规范名、md5 增量、既有产物收养、原子写、批量失败隔离、孤儿清理、
// 产物字节格式（与 Python json.dumps 兼容序列化）。全部 MockLlm，零真实调用。
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLlm } from "plexus";
import type { CorpusConfig } from "../src/types/canopy.types.js";
import {
  getResultPath,
  indexFile,
  indexBatch,
  cleanupOrphans,
  listSourceFiles,
} from "../src/indexing.js";

let root: string;
let corpus: CorpusConfig;
const llm = new MockLlm(() => "MOCK-SUMMARY");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "canopy-idx-"));
  mkdirSync(join(root, "vault/sub dir"), { recursive: true });
  mkdirSync(join(root, "results"));
  corpus = {
    name: "t",
    source: { dir: join(root, "vault"), glob: "**/*.md", ignore: [] },
    resultsDir: join(root, "results"),
    backend: "memory",
    llm: { baseURL: "https://x/v1", apiKey: "k", model: "m" },
    summaryTokenThreshold: 200,
    concurrency: 5,
  };
});

describe("getResultPath 规范名（ADR-006）", () => {
  it("嵌套 + 空格：'/'→'__'、' '→'_'、去扩展名", () => {
    const p = getResultPath(corpus, join(root, "vault/sub dir/My Note.md"));
    expect(p).toBe(join(root, "results/sub_dir__My_Note_structure.json"));
  });
  it("corpus 外文件 → throw", () => {
    expect(() => getResultPath(corpus, join(root, "elsewhere.md"))).toThrow(/不在 corpus/);
  });
});

describe("indexFile", () => {
  it("新文件 → ok；产物含 text + summary 追加在键序末尾；无 .tmp 残留", async () => {
    const md = join(root, "vault/note.md");
    writeFileSync(md, "# Title\nbody text\n## Child\nchild body");
    const r = await indexFile(corpus, llm, md);
    expect(r.outcome).toBe("ok");
    const product = JSON.parse(readFileSync(r.result_path, "utf-8")) as Record<string, unknown>;
    expect(Object.keys(product)).toEqual(["doc_name", "line_count", "structure"]);
    expect(product["doc_name"]).toBe("note");
    const rootNode = (product["structure"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(Object.keys(rootNode)).toEqual(["title", "node_id", "line_num", "text", "nodes", "prefix_summary"]);
    expect(rootNode["prefix_summary"]).toBe("# Title\nbody text"); // 短文本 → 原文不调 LLM
    expect(readdirSync(corpus.resultsDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("未变更 → skipped-unchanged；改内容 → 重建", async () => {
    const md = join(root, "vault/note.md");
    writeFileSync(md, "# A\nv1");
    await indexFile(corpus, llm, md);
    const r2 = await indexFile(corpus, llm, md);
    expect(r2.outcome).toBe("skipped-unchanged");
    writeFileSync(md, "# A\nv2 changed");
    const r3 = await indexFile(corpus, llm, md);
    expect(r3.outcome).toBe("ok");
    const product = JSON.parse(readFileSync(r3.result_path, "utf-8")) as { structure: Array<{ text: string }> };
    expect(product.structure[0]?.text).toContain("v2");
  });

  it("--force 忽略增量强制重建", async () => {
    const md = join(root, "vault/note.md");
    writeFileSync(md, "# A\nv1");
    await indexFile(corpus, llm, md);
    const r = await indexFile(corpus, llm, md, { force: true });
    expect(r.outcome).toBe("ok");
  });

  it("收养既有产物（无 md5 记录 + 产物含 structure）→ skipped，不烧 LLM（47MB 资产零重建）", async () => {
    const md = join(root, "vault/legacy.md");
    writeFileSync(md, "# Legacy\nbody");
    // 模拟 molly.pageindex 旧产物（无状态侧车）
    writeFileSync(
      getResultPath(corpus, md),
      JSON.stringify({ doc_name: "legacy", line_count: 2, structure: [] }, null, 2),
    );
    let called = 0;
    const spyLlm = new MockLlm(() => {
      called++;
      return "x";
    });
    const r = await indexFile(corpus, spyLlm, md);
    expect(r.outcome).toBe("skipped-unchanged");
    expect(called).toBe(0);
    // 收养后改文件 → md5 不匹配 → 重建
    writeFileSync(md, "# Legacy\nchanged body");
    const r2 = await indexFile(corpus, spyLlm, md);
    expect(r2.outcome).toBe("ok");
  });

  it("损坏产物（半个 JSON）不算已索引 → 重建", async () => {
    const md = join(root, "vault/broken.md");
    writeFileSync(md, "# B\nbody");
    writeFileSync(getResultPath(corpus, md), "{half json");
    const r = await indexFile(corpus, llm, md);
    expect(r.outcome).toBe("ok");
  });
});

describe("listSourceFiles / 批量", () => {
  it("点目录无条件不进（.claude/.obsidian 防线）", () => {
    mkdirSync(join(root, "vault/.claude/worktrees"), { recursive: true });
    writeFileSync(join(root, "vault/.claude/worktrees/x.md"), "# X");
    writeFileSync(join(root, "vault/ok.md"), "# OK");
    const files = listSourceFiles(corpus);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("ok.md");
  });

  it("indexBatch：计数 + 失败隔离（fail loud at end）+ 孤儿清理", async () => {
    writeFileSync(join(root, "vault/a.md"), "# A\nbody");
    writeFileSync(join(root, "vault/b.md"), "# B\nbody");
    // 孤儿：results 里有、vault 里没有
    writeFileSync(
      join(root, "results/ghost_structure.json"),
      JSON.stringify({ doc_name: "ghost", structure: [] }),
    );
    const report = await indexBatch(corpus, llm);
    expect(report.indexed).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.orphans_removed).toEqual(["ghost_structure.json"]);
    expect(existsSync(join(root, "results/ghost_structure.json"))).toBe(false);
    // 二跑全 skip
    const report2 = await indexBatch(corpus, llm);
    expect(report2.indexed).toBe(0);
    expect(report2.skipped).toBe(2);
  });

  it("单文件失败计入 failures，其余继续", async () => {
    writeFileSync(join(root, "vault/good.md"), "# G\nbody");
    writeFileSync(join(root, "vault/bad.md"), "# Bad\n" + "long ".repeat(300));
    const failingLlm = new MockLlm((req) => {
      if (req.prompt.includes("long")) throw new Error("LLM boom");
      return "ok-summary";
    });
    const report = await indexBatch(corpus, failingLlm);
    expect(report.indexed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.failures[0]?.file).toContain("bad.md");
    expect(report.failures[0]?.error).toMatch(/摘要失败|boom/);
  });

  it("cleanupOrphans 同步清状态侧车", async () => {
    const md = join(root, "vault/temp.md");
    writeFileSync(md, "# T\nbody");
    await indexFile(corpus, llm, md);
    rmSync(md);
    const removed = cleanupOrphans(corpus);
    expect(removed).toEqual(["temp_structure.json"]);
    const state = JSON.parse(readFileSync(join(root, "results/.canopy-state.json"), "utf-8")) as {
      md5: Record<string, string>;
    };
    expect(state.md5["temp_structure.json"]).toBeUndefined();
  });
});
