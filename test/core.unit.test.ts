// core 单元测试：heading 状态机、缩进 heading 丢弃、thinning、键序/空 nodes 省略。
import { describe, it, expect } from "vitest";
import {
  extractNodesFromMarkdown,
  extractNodeTextContent,
  buildTreeFromNodes,
  updateNodeListWithTokenCount,
  treeThinningForIndex,
  mdToTree,
  stripText,
} from "../src/core/tree.js";
import type { TreeNode } from "../src/types/canopy.types.js";

describe("extractNodesFromMarkdown", () => {
  it("``` 代码块内的 # 忽略（状态机翻转）", () => {
    const md = "# A\n```\n# not a heading\n```\n## B";
    const { nodeList } = extractNodesFromMarkdown(md);
    expect(nodeList.map((n) => n.node_title)).toEqual(["A", "B"]);
    expect(nodeList.map((n) => n.line_num)).toEqual([1, 5]);
  });

  it("# 后无空格不是 heading", () => {
    const { nodeList } = extractNodesFromMarkdown("#NoSpace\n# Yes");
    expect(nodeList.map((n) => n.node_title)).toEqual(["Yes"]);
  });

  it("7 个 # 不是 heading（####### 前 6 个匹配 + 第 7 个进 title？不——\\s 不匹配 #）", () => {
    const { nodeList } = extractNodesFromMarkdown("####### seven");
    // Python 行为：^#{1,6}\s+ 要求 # 后是空白，"#######" 第 7 字符是 # 非空白 → 不匹配
    expect(nodeList).toEqual([]);
  });

  it("行内缩进的 heading：strip 后能匹配 → 进 nodeList", () => {
    const { nodeList } = extractNodesFromMarkdown("  # Indented");
    expect(nodeList.length).toBe(1);
  });
});

describe("extractNodeTextContent", () => {
  it("缩进 heading 在 raw-line re-match 阶段被丢弃（Python 行为复刻）", () => {
    const md = "  # Indented\ncontent";
    const { nodeList, lines } = extractNodesFromMarkdown(md);
    const nodes = extractNodeTextContent(nodeList, lines);
    expect(nodes).toEqual([]);
  });

  it("节点文本 = 自身 heading 行到下一 heading 前（strip 后）", () => {
    const md = "# A\nbody a\n\n## B\nbody b";
    const { nodeList, lines } = extractNodesFromMarkdown(md);
    const nodes = extractNodeTextContent(nodeList, lines);
    expect(nodes[0]?.text).toBe("# A\nbody a");
    expect(nodes[1]?.text).toBe("## B\nbody b");
    expect(nodes[0]?.level).toBe(1);
    expect(nodes[1]?.level).toBe(2);
  });
});

describe("buildTreeFromNodes / mdToTree", () => {
  it("栈式按 level 建树，node_id 1-based 文档序（生产事实格式，golden 钉死）", () => {
    const doc = mdToTree("# A\n## B\n### C\n## D\n# E", { docName: "t", withText: true });
    const s = doc.structure;
    expect(s.map((n) => n.node_id)).toEqual(["0001", "0005"]);
    expect(s[0]?.nodes?.map((n) => n.node_id)).toEqual(["0002", "0004"]);
    expect(s[0]?.nodes?.[0]?.nodes?.[0]?.node_id).toBe("0003");
  });

  it("level 跳跃（# 直接到 ###）：### 挂在 # 下", () => {
    const doc = mdToTree("# A\n### C", { docName: "t", withText: true });
    expect(doc.structure[0]?.nodes?.[0]?.title).toBe("C");
  });

  it("空文档 → structure: []，line_count 正确", () => {
    const doc = mdToTree("no headings here\njust text", { docName: "t" });
    expect(doc.structure).toEqual([]);
    expect(doc.line_count).toBe(2);
  });

  it("叶节点省略空 nodes 字段；键序 = title,node_id,line_num,text（withText）", () => {
    const doc = mdToTree("# A", { docName: "t", withText: true });
    expect(Object.keys(doc.structure[0] as object)).toEqual([
      "title",
      "node_id",
      "line_num",
      "text",
    ]);
  });

  it("不带 text（withText 缺省）键序 = title,node_id,line_num", () => {
    const doc = mdToTree("# A\n## B", { docName: "t" });
    expect(Object.keys(doc.structure[0] as object)).toEqual([
      "title",
      "node_id",
      "line_num",
      "nodes",
    ]);
    expect(Object.keys(doc.structure[0]?.nodes?.[0] as object)).toEqual([
      "title",
      "node_id",
      "line_num",
    ]);
  });

  it("thinning=true 而 minTokens 缺失 → fail loud", () => {
    expect(() => mdToTree("# A", { docName: "t", thinning: true })).toThrow(/minTokens/);
  });

  it("thinning：小节点的子节点向父合并", () => {
    const md = "# P\nshort\n## C1\nchild one\n## C2\nchild two";
    const { nodeList, lines } = extractNodesFromMarkdown(md);
    let nodes = extractNodeTextContent(nodeList, lines);
    nodes = updateNodeListWithTokenCount(nodes);
    const thinned = treeThinningForIndex(nodes, 10_000);
    expect(thinned.length).toBe(1);
    expect(thinned[0]?.text).toContain("child one");
    expect(thinned[0]?.text).toContain("child two");
  });
});

describe("stripText", () => {
  it("摘要生成后去 text 保 summary（键序 title,node_id,line_num,summary）", () => {
    const tree: TreeNode[] = [
      { title: "A", node_id: "0001", line_num: 1, text: "# A", summary: "s" } as TreeNode,
    ];
    const out = stripText(tree);
    expect(Object.keys(out[0] as object)).toEqual(["title", "node_id", "line_num", "summary"]);
  });
});
