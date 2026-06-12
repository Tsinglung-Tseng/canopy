// M4：MockLlm 确定性测试——摘要字段落位、阈值分支、askSchema 拒畸形输出、
// Budget 见底 throw、search 两阶段编排。
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, makeCtx, Budget, BudgetExhausted } from "../src/llm/kernel.js";
import type { LlmRequest } from "../src/llm/kernel.js";
import { MockLlm } from "../src/llm/mock.js";
import { summarizeNode, buildSummaries, buildSummaryCache, selectNodesOrEmpty } from "../src/llm/agents.js";
import { searchAgent } from "../src/search.js";
import { mdToTree } from "../src/core/tree.js";
import type { DocStructure, TreeNode } from "../src/types/canopy.types.js";

const LONG_TEXT = "long token ".repeat(300); // 远超 200 token 阈值

describe("summarizeNode", () => {
  it("<阈值：原文直返，零 LLM 调用零成本", async () => {
    let called = 0;
    const llm = new MockLlm(() => {
      called++;
      return "SHOULD NOT BE CALLED";
    });
    const r = await run(summarizeNode("short text", 200), llm);
    expect(r.outcome.ok && r.outcome.value).toBe("short text");
    expect(called).toBe(0);
    expect(r.spent.calls).toBe(0);
  });

  it(">=阈值：ask 生成", async () => {
    const llm = new MockLlm(() => "generated summary");
    const r = await run(summarizeNode(LONG_TEXT, 200), llm);
    expect(r.outcome.ok && r.outcome.value).toBe("generated summary");
    expect(r.spent.calls).toBe(1);
  });
});

describe("buildSummaries", () => {
  it("叶节点写 summary、非叶写 prefix_summary，键追加在末尾", async () => {
    const doc = mdToTree(`# Parent\nshort intro\n## Leaf\n${LONG_TEXT}`, {
      docName: "t",
      withText: true,
    });
    const llm = new MockLlm(() => "LLM-SUM");
    const r = await run(buildSummaries(doc, 200), llm);
    expect(r.outcome.ok).toBe(true);
    const out = (r.outcome.ok && r.outcome.value) as DocStructure;
    const parent = out.structure[0] as TreeNode;
    const leaf = parent.nodes?.[0] as TreeNode;
    expect(parent.prefix_summary).toBe("# Parent\nshort intro"); // 短 → 原文
    expect(parent.summary).toBeUndefined();
    expect(leaf.summary).toBe("LLM-SUM"); // 长 → LLM
    expect(leaf.prefix_summary).toBeUndefined();
    // 键序：summary 类字段追加在末尾（既有产物的事实字节序）
    expect(Object.keys(parent)).toEqual(["title", "node_id", "line_num", "text", "nodes", "prefix_summary"]);
    expect(Object.keys(leaf)).toEqual(["title", "node_id", "line_num", "text", "summary"]);
    expect(r.spent.calls).toBe(1); // 只有长叶节点调了 LLM
  });

  it("无 text 的树 → fail loud", async () => {
    const doc = mdToTree("# A", { docName: "t" }); // 无 withText
    const llm = new MockLlm(() => "x");
    await expect(run(buildSummaries(doc, 200), llm)).rejects.toThrow(/缺 text/);
  });
});

describe("M8.5 节点级摘要复用", () => {
  // 文档：一个长叶节点（>阈值，烧 LLM）+ 一个短父节点（原文，零成本）
  const src = `# Parent\nshort intro\n## Leaf\n${LONG_TEXT}`;

  it("buildSummaryCache 只收录 LLM 摘要（原文摘要不进缓存）", async () => {
    const doc = mdToTree(src, { docName: "t", withText: true });
    const r = await run(buildSummaries(doc, 200), new MockLlm(() => "LLM-SUM"));
    const out = (r.outcome.ok && r.outcome.value) as DocStructure;
    const cache = buildSummaryCache(out);
    // 仅长叶节点（prefix/summary !== text）入缓存；短父节点原文摘要被排除
    expect(cache.size).toBe(1);
    expect([...cache.values()]).toEqual(["LLM-SUM"]);
  });

  it("正文未变 → 复用既往摘要、零 LLM 调用", async () => {
    const doc1 = mdToTree(src, { docName: "t", withText: true });
    const r1 = await run(buildSummaries(doc1, 200), new MockLlm(() => "OLD-SUM"));
    const cache = buildSummaryCache((r1.outcome.ok && r1.outcome.value) as DocStructure);

    // 二次索引：同正文 + 命中缓存的 LLM 应当一次都不被调用
    const doc2 = mdToTree(src, { docName: "t", withText: true });
    let calls = 0;
    const r2 = await run(
      buildSummaries(doc2, 200, cache),
      new MockLlm(() => { calls++; return "NEW-SUM"; }),
    );
    expect(calls).toBe(0);
    expect(r2.spent.calls).toBe(0);
    const leaf = ((r2.outcome.ok && r2.outcome.value) as DocStructure).structure[0]?.nodes?.[0] as TreeNode;
    expect(leaf.summary).toBe("OLD-SUM"); // 复用旧值，未重生成
  });

  it("正文变更 → 缓存未命中、重新生成", async () => {
    const doc1 = mdToTree(src, { docName: "t", withText: true });
    const r1 = await run(buildSummaries(doc1, 200), new MockLlm(() => "OLD-SUM"));
    const cache = buildSummaryCache((r1.outcome.ok && r1.outcome.value) as DocStructure);

    const doc2 = mdToTree(`# Parent\nshort intro\n## Leaf\n${LONG_TEXT} EDITED`, {
      docName: "t",
      withText: true,
    });
    let calls = 0;
    const r2 = await run(
      buildSummaries(doc2, 200, cache),
      new MockLlm(() => { calls++; return "NEW-SUM"; }),
    );
    expect(calls).toBe(1); // 正文改了 → md5 不命中 → 重烧
    const leaf = ((r2.outcome.ok && r2.outcome.value) as DocStructure).structure[0]?.nodes?.[0] as TreeNode;
    expect(leaf.summary).toBe("NEW-SUM");
  });
});

describe("selectNodesOrEmpty（askSchema 结构化）", () => {
  it("合法 JSON → node_ids", async () => {
    const llm = new MockLlm(() => '{"node_ids":["0001","0003"]}');
    const r = await run(selectNodesOrEmpty("q", "{}", "f.json"), llm);
    expect(r.outcome.ok && r.outcome.value).toEqual(["0001", "0003"]);
  });

  it("畸形输出 → 空命中降级（不崩，对齐 Python except 语义）", async () => {
    const llm = new MockLlm(() => "NOT JSON AT ALL");
    const r = await run(selectNodesOrEmpty("q", "{}", "f.json"), llm);
    expect(r.outcome.ok && r.outcome.value).toEqual([]);
  });

  it("JSON 但缺 node_ids 键 → 空命中降级", async () => {
    const llm = new MockLlm(() => '{"wrong_key":[]}');
    const r = await run(selectNodesOrEmpty("q", "{}", "f.json"), llm);
    expect(r.outcome.ok && r.outcome.value).toEqual([]);
  });
});

describe("Budget", () => {
  it("见底 throw BudgetExhausted（fail loud，无静默降级）", async () => {
    const llm = new MockLlm(() => "x".repeat(4000));
    const budget = new Budget(1); // 1 token 上限
    const ctx = makeCtx(llm, budget);
    const first = await summarizeNode(LONG_TEXT, 200)(ctx); // 第一次成功并扣费
    expect(first.ok).toBe(true);
    await expect(summarizeNode(LONG_TEXT, 200)(ctx)).rejects.toThrow(BudgetExhausted);
  });
});

describe("searchAgent 两阶段编排", () => {
  function makeResultsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "canopy-llm-test-"));
    writeFileSync(
      join(dir, "Rust_Notes_structure.json"),
      JSON.stringify({
        doc_name: "Rust Notes",
        line_count: 8,
        structure: [
          {
            title: "Ownership",
            node_id: "0001",
            line_num: 1,
            text: "# Ownership\nborrow checker rust lifetimes ownership",
            summary: "rust ownership summary",
            nodes: [
              {
                title: "Borrowing",
                node_id: "0002",
                line_num: 4,
                text: "## Borrowing\nmutable references rust",
                summary: "borrowing summary",
              },
            ],
          },
        ],
      }),
    );
    return dir;
  }

  function scriptedLlm(): MockLlm {
    return new MockLlm((req: LlmRequest) => {
      if (req.prompt.includes("smart search assistant")) return '{"node_ids":["0002"]}';
      if (req.prompt.includes("helpful assistant")) return "FINAL ANSWER";
      throw new Error(`unexpected prompt: ${req.prompt.slice(0, 60)}`);
    });
  }

  it("stage1 命中 → stage2 选节点 → hits + 答案合成", async () => {
    const dir = makeResultsDir();
    const r = await run(
      searchAgent(dir, "rust ownership", { topK: 5, concurrency: 5, answer: true, lang: "en" }),
      scriptedLlm(),
    );
    expect(r.outcome.ok).toBe(true);
    const out = r.outcome.ok ? r.outcome.value : null;
    expect(out?.results.length).toBe(1);
    expect(out?.results[0]?.note_name).toBe("Rust_Notes");
    expect(out?.results[0]?.hits).toEqual([
      { node_id: "0002", title: "Borrowing", summary: "borrowing summary" },
    ]);
    expect(out?.answer).toBe("FINAL ANSWER");
  });

  it("--no-answer：跳过合成（少一次 LLM 调用）", async () => {
    const dir = makeResultsDir();
    const r = await run(
      searchAgent(dir, "rust ownership", { topK: 5, concurrency: 5, answer: false, lang: "en" }),
      scriptedLlm(),
    );
    const out = r.outcome.ok ? r.outcome.value : null;
    expect(out?.answer).toBeUndefined();
    expect(r.spent.calls).toBe(1); // 仅 stage-2
  });

  it("BM25 零命中 → 空结果不调 LLM（零命中不是错误）", async () => {
    const dir = makeResultsDir();
    const r = await run(
      searchAgent(dir, "quantum chromodynamics", { topK: 5, concurrency: 5, answer: true, lang: "en" }),
      scriptedLlm(),
    );
    const out = r.outcome.ok ? r.outcome.value : null;
    expect(out?.results).toEqual([]);
    expect(r.spent.calls).toBe(0);
  });

  it("stage2 全部空选 → answer 提示无相关节点", async () => {
    const dir = makeResultsDir();
    const llm = new MockLlm((req: LlmRequest) =>
      req.prompt.includes("smart search assistant") ? '{"node_ids":[]}' : "NOPE",
    );
    const r = await run(
      searchAgent(dir, "rust ownership", { topK: 5, concurrency: 5, answer: true, lang: "en" }),
      llm,
    );
    const out = r.outcome.ok ? r.outcome.value : null;
    expect(out?.answer).toMatch(/no relevant nodes/);
    expect(out?.results[0]?.hits).toEqual([]);
  });
});
