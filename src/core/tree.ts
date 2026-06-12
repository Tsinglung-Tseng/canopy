// core — markdown → 文档树（纯函数，无 LLM 无 IO）。
// 移植自 molly.pageindex/pageindex/page_index_md.py + utils.py 子集，
// 行为以 golden 对照锁死（test/core.golden.test.ts），不靠记忆。
import type { DocStructure, TreeNode } from "../types/canopy.types.js";
import { countTokens } from "./tokens.js";

export interface HeadingNode {
  node_title: string;
  line_num: number;
}

export interface FlatNode {
  title: string;
  line_num: number;
  level: number;
  text: string;
  text_token_count?: number;
}

/** 内存树节点：建树阶段恒有 text 与 nodes（formatStructure 之后才省略）。 */
export interface RawTreeNode {
  title: string;
  node_id: string;
  text: string;
  line_num: number;
  nodes: RawTreeNode[];
  summary?: string;
  prefix_summary?: string;
}

const HEADER_PATTERN = /^(#{1,6})\s+(.+)$/;
const CODE_BLOCK_PATTERN = /^```/;

/** heading 扫描：``` 代码块内的 # 忽略（状态机翻转）。 */
export function extractNodesFromMarkdown(markdownContent: string): {
  nodeList: HeadingNode[];
  lines: string[];
} {
  const nodeList: HeadingNode[] = [];
  const lines = markdownContent.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const stripped = (lines[i] as string).trim();
    if (CODE_BLOCK_PATTERN.test(stripped)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!stripped) continue;
    if (!inCodeBlock) {
      const m = stripped.match(HEADER_PATTERN);
      if (m) nodeList.push({ node_title: (m[2] as string).trim(), line_num: i + 1 });
    }
  }
  return { nodeList, lines };
}

/** 每节点文本 = 自身 heading 行到下一 heading 前。
 *  与 Python 版一致：heading 行以「原始行」（非 strip 后）re-match 定 level，
 *  缩进的 heading 在此被丢弃（用户输入容忍，golden 锁定该行为）。 */
export function extractNodeTextContent(
  nodeList: HeadingNode[],
  markdownLines: string[],
): FlatNode[] {
  const allNodes: FlatNode[] = [];
  for (const node of nodeList) {
    const lineContent = markdownLines[node.line_num - 1] as string;
    const headerMatch = lineContent.match(/^(#{1,6})/);
    if (!headerMatch) continue; // Python 版打印 warning 后跳过
    allNodes.push({
      title: node.node_title,
      line_num: node.line_num,
      level: (headerMatch[1] as string).length,
      text: "",
    });
  }
  for (let i = 0; i < allNodes.length; i++) {
    const node = allNodes[i] as FlatNode;
    const startLine = node.line_num - 1;
    const endLine =
      i + 1 < allNodes.length ? (allNodes[i + 1] as FlatNode).line_num - 1 : markdownLines.length;
    node.text = markdownLines.slice(startLine, endLine).join("\n").trim();
  }
  return allNodes;
}

function findAllChildren(parentIndex: number, parentLevel: number, nodeList: FlatNode[]): number[] {
  const children: number[] = [];
  for (let i = parentIndex + 1; i < nodeList.length; i++) {
    if ((nodeList[i] as FlatNode).level <= parentLevel) break;
    children.push(i);
  }
  return children;
}

/** 含全部后代文本的 token 计数（thinning 前置步骤）。 */
export function updateNodeListWithTokenCount(nodeList: FlatNode[]): FlatNode[] {
  const result = nodeList.map((n) => ({ ...n }));
  for (let i = result.length - 1; i >= 0; i--) {
    const current = result[i] as FlatNode;
    const childrenIndices = findAllChildren(i, current.level, result);
    let totalText = current.text ?? "";
    for (const ci of childrenIndices) {
      const childText = (result[ci] as FlatNode).text ?? "";
      if (childText) totalText += "\n" + childText;
    }
    current.text_token_count = countTokens(totalText);
  }
  return result;
}

/** 小节点向父节点合并（现行生产链路未启用，移植但默认关）。 */
export function treeThinningForIndex(nodeList: FlatNode[], minNodeToken: number): FlatNode[] {
  const result = nodeList.map((n) => ({ ...n }));
  const nodesToRemove = new Set<number>();

  for (let i = result.length - 1; i >= 0; i--) {
    if (nodesToRemove.has(i)) continue;
    const current = result[i] as FlatNode;
    const totalTokens = current.text_token_count ?? 0;
    if (totalTokens < minNodeToken) {
      const childrenIndices = findAllChildren(i, current.level, result);
      const childrenTexts: string[] = [];
      for (const ci of [...childrenIndices].sort((a, b) => a - b)) {
        if (!nodesToRemove.has(ci)) {
          const childText = (result[ci] as FlatNode).text ?? "";
          if (childText.trim()) childrenTexts.push(childText);
          nodesToRemove.add(ci);
        }
      }
      if (childrenTexts.length) {
        let merged = current.text ?? "";
        for (const childText of childrenTexts) {
          if (merged && !merged.endsWith("\n")) merged += "\n\n";
          merged += childText;
        }
        current.text = merged;
        current.text_token_count = countTokens(merged);
      }
    }
  }
  const sorted = [...nodesToRemove].sort((a, b) => b - a);
  for (const idx of sorted) result.splice(idx, 1);
  return result;
}

/** 栈式按 level 建树。node_id 此处 1 起零填充，随后 writeNodeId 先序重写为 "0000" 起。 */
export function buildTreeFromNodes(nodeList: FlatNode[]): RawTreeNode[] {
  if (!nodeList.length) return [];
  const stack: Array<[RawTreeNode, number]> = [];
  const rootNodes: RawTreeNode[] = [];
  let counter = 1;

  for (const node of nodeList) {
    const treeNode: RawTreeNode = {
      title: node.title,
      node_id: String(counter).padStart(4, "0"),
      text: node.text,
      line_num: node.line_num,
      nodes: [],
    };
    counter++;
    while (stack.length && (stack[stack.length - 1] as [RawTreeNode, number])[1] >= node.level) {
      stack.pop();
    }
    if (!stack.length) {
      rootNodes.push(treeNode);
    } else {
      (stack[stack.length - 1] as [RawTreeNode, number])[0].nodes.push(treeNode);
    }
    stack.push([treeNode, node.level]);
  }
  return rootNodes;
}

/** 先序重写 node_id（"0000" 起）——与既有产物对齐（utils.write_node_id）。 */
export function writeNodeId(data: unknown, nodeId = 0): number {
  if (Array.isArray(data)) {
    for (const item of data) nodeId = writeNodeId(item, nodeId);
    return nodeId;
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    obj["node_id"] = String(nodeId).padStart(4, "0");
    nodeId++;
    for (const key of Object.keys(obj)) {
      if (key.includes("nodes")) nodeId = writeNodeId(obj[key], nodeId);
    }
    return nodeId;
  }
  return nodeId;
}

/** 键序重排 + 空 nodes 字段省略（utils.format_structure / reorder_dict）。
 *  JSON.stringify 按插入序输出，因此该重排同时决定产物字节序（兼容序列化器的前提）。 */
export function formatStructure<T>(structure: T, order: string[]): T {
  if (Array.isArray(structure)) {
    return structure.map((item) => formatStructure(item, order)) as unknown as T;
  }
  if (structure && typeof structure === "object") {
    const obj = { ...(structure as Record<string, unknown>) };
    if ("nodes" in obj) obj["nodes"] = formatStructure(obj["nodes"], order);
    const nodes = obj["nodes"];
    if (!nodes || (Array.isArray(nodes) && nodes.length === 0)) delete obj["nodes"];
    const reordered: Record<string, unknown> = {};
    for (const key of order) {
      if (key in obj) reordered[key] = obj[key];
    }
    return reordered as unknown as T;
  }
  return structure;
}

/** 树 → 节点先序列表（utils.structure_to_list）。返回对原节点的引用，可就地写摘要。 */
export function structureToList(structure: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(structure)) {
    const out: Array<Record<string, unknown>> = [];
    for (const item of structure) out.push(...structureToList(item));
    return out;
  }
  if (structure && typeof structure === "object") {
    const obj = structure as Record<string, unknown>;
    const out: Array<Record<string, unknown>> = [obj];
    if ("nodes" in obj) out.push(...structureToList(obj["nodes"]));
    return out;
  }
  return [];
}

export const ORDER_WITH_TEXT = [
  "title",
  "node_id",
  "line_num",
  "summary",
  "prefix_summary",
  "text",
  "nodes",
];
export const ORDER_NO_TEXT = ["title", "node_id", "line_num", "summary", "prefix_summary", "nodes"];

export interface MdToTreeOpts {
  /** DocStructure.doc_name（不含扩展名的源文件名）——core 纯函数不碰文件系统，调用方传入。 */
  docName: string;
  thinning?: boolean;
  minTokens?: number;
  /** 保留节点 text（llm 摘要阶段需要；产物落盘前用 stripText 去掉）。 */
  withText?: boolean;
}

/** markdown 文本 → 文档树。不含 summary 字段——摘要是 llm 模块的事。
 *
 *  node_id 语义（golden 实测钉死，2026-06-11）：既有产物全部是 build_tree 的
 *  1-based 编号（"0001" 起，文档序 = 先序）。Python 生产链路 run_pageindex.py 的
 *  md 分支把 if_add_node_id=None 覆盖进 config，write_node_id 实际从未执行——
 *  该事实格式即 ADR-006 兼容契约，故此处不调 writeNodeId（函数保留导出仅作对照）。 */
export function mdToTree(markdownContent: string, opts: MdToTreeOpts): DocStructure {
  const lineCount = (markdownContent.match(/\n/g)?.length ?? 0) + 1;
  const { nodeList, lines } = extractNodesFromMarkdown(markdownContent);
  let nodesWithContent = extractNodeTextContent(nodeList, lines);

  if (opts.thinning) {
    if (opts.minTokens === undefined) {
      throw new Error("mdToTree: thinning=true 需要显式 minTokens（无静默默认）");
    }
    nodesWithContent = updateNodeListWithTokenCount(nodesWithContent);
    nodesWithContent = treeThinningForIndex(nodesWithContent, opts.minTokens);
  }

  const tree = buildTreeFromNodes(nodesWithContent);
  const order = opts.withText ? ORDER_WITH_TEXT : ORDER_NO_TEXT;
  const structure = formatStructure(tree, order) as unknown as TreeNode[];

  return { doc_name: opts.docName, line_count: lineCount, structure };
}

/** 摘要生成后去掉 text 字段（md_to_tree if_add_node_text='no' 路径）。 */
export function stripText(structure: TreeNode[]): TreeNode[] {
  return formatStructure(structure, ORDER_NO_TEXT);
}
