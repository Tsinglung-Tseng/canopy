// retrieval 测试：BM25 分数与 Python 原版离线对照（容差 1e-9）、分词对照表、
// 后端 top-k/零分截断、产物加载与文件名还原。
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BM25 } from "../src/retrieval/bm25.js";
import { tokenize } from "../src/retrieval/tokenize.js";
import { MemoryBM25Backend } from "../src/retrieval/backend.js";
import {
  loadDocs,
  findDocs,
  resultFilenameToNoteName,
  treeSummary,
  nodeMap,
} from "../src/retrieval/docs.js";

const CORPUS = [
  "the quick brown fox jumps over the lazy dog".split(" "),
  "a quick brown dog outpaces a quick fox".split(" "),
  "machine learning models train on data".split(" "),
  "deep learning is a subset of machine learning".split(" "),
];

describe("BM25 与 Python 原版分数逐位一致（离线算出，2026-06-11）", () => {
  const cases: Array<[string[], number[]]> = [
    [["quick", "fox"], [1.2924849682621535, 1.6632778004709647, 0.0, 0.0]],
    [["machine", "learning"], [0.0, 0.0, 1.5430924665966466, 1.6632778004709647]],
    [["dog"], [0.6462424841310768, 0.6832293353691036, 0.0, 0.0]],
    [["nonexistent"], [0.0, 0.0, 0.0, 0.0]],
  ];
  for (const [query, expected] of cases) {
    it(query.join("+"), () => {
      const scores = new BM25(CORPUS).getScores(query);
      expect(scores.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(Math.abs((scores[i] as number) - (expected[i] as number))).toBeLessThan(1e-9);
      }
    });
  }
});

describe("tokenize", () => {
  it("英文：lowercase + 标点剥除", () => {
    expect(tokenize("Hello, World! foo-bar")).toEqual(["hello", "world", "foo", "bar"]);
  });
  it("CJK 走 jieba 词级切分（不逐字）", () => {
    const t = tokenize("机器学习模型训练");
    expect(t).toContain("机器");
    expect(t).toContain("学习");
    expect(t.every((w) => w.length >= 1)).toBe(true);
  });
  it("中英混排 + 中文标点剥除", () => {
    const t = tokenize("使用 BM25 检索，效果很好。CSS 配色");
    expect(t).toContain("bm25");
    expect(t).toContain("css");
    expect(t).toContain("检索");
    expect(t.join("")).not.toContain("，");
  });
  it("空串 → []", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("，。！？")).toEqual([]);
  });
});

describe("MemoryBM25Backend", () => {
  it("top-k 截断 + 零分文档不进候选", () => {
    const b = new MemoryBM25Backend();
    CORPUS.forEach((tokens, i) => b.upsert({ id: `d${i}`, tokens }));
    const hits = b.query(["quick", "fox"], 5);
    expect(hits.map((h) => h.id)).toEqual(["d1", "d0"]); // 零分的 d2/d3 被截
    expect(b.query(["nonexistent"], 5)).toEqual([]);
    expect(b.query(["learning"], 1).length).toBe(1);
  });
  it("remove 后不再命中", () => {
    const b = new MemoryBM25Backend();
    CORPUS.forEach((tokens, i) => b.upsert({ id: `d${i}`, tokens }));
    b.remove("d1");
    expect(b.query(["quick", "fox"], 5).map((h) => h.id)).toEqual(["d0"]);
  });
});

describe("产物加载与 find 链路", () => {
  function makeResultsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "canopy-test-"));
    writeFileSync(
      join(dir, "folder__My_Note_structure.json"),
      JSON.stringify({
        doc_name: "My Note",
        line_count: 5,
        structure: [
          {
            title: "Rust ownership",
            node_id: "0001",
            line_num: 1,
            text: "# Rust ownership\nborrow checker lifetimes",
            summary: "rust 所有权与借用检查",
          },
        ],
      }),
    );
    writeFileSync(
      join(dir, "Other_structure.json"),
      JSON.stringify({
        doc_name: "Other",
        line_count: 3,
        structure: [
          { title: "Cooking pasta", node_id: "0001", line_num: 1, text: "boil water al dente" },
        ],
      }),
    );
    writeFileSync(join(dir, "broken.json"), "{not json"); // 兼容层：坏文件跳过不崩
    return dir;
  }

  it("loadDocs 提取 title/summary/text，坏 JSON 跳过", () => {
    const docs = loadDocs(makeResultsDir());
    expect(docs.length).toBe(2);
    const doc = docs.find((d) => d.filename === "folder__My_Note_structure.json");
    expect(doc?.tokens).toContain("rust");
    expect(doc?.tokens).toContain("所有权");
  });

  it("findDocs 端到端（无 LLM）", () => {
    const hits = findDocs(makeResultsDir(), "rust borrow checker", 5);
    expect(hits.length).toBe(1);
    expect(hits[0]?.noteName).toBe("My_Note");
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("resultsDir 不存在 → 空结果（零命中不是错误，ADR-004）", () => {
    expect(findDocs("/nonexistent/dir", "q", 5)).toEqual([]);
  });

  it("resultFilenameToNoteName", () => {
    expect(resultFilenameToNoteName("folder__sub__My_Note_structure.json")).toBe("My_Note");
    expect(resultFilenameToNoteName("Plain_structure.json")).toBe("Plain");
  });

  it("treeSummary 只含 id/title/summary 骨架；nodeMap 扁平化", () => {
    const tree = {
      doc_name: "d",
      structure: [
        {
          title: "A",
          node_id: "0001",
          text: "secret text",
          summary: "sum",
          nodes: [{ title: "B", node_id: "0002", text: "t2" }],
        },
      ],
    };
    const s = treeSummary(tree);
    expect(s).toContain('"id":"0001"');
    expect(s).toContain('"title":"B"');
    expect(s).not.toContain("secret text");
    const m = nodeMap(tree);
    expect([...m.keys()]).toEqual(["0001", "0002"]);
  });
});
