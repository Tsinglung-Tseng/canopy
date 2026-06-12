// 索引产物加载 + stage-1 检索（canopy find 的全部、search 的前半）。
// 移植 molly.pageindex retrieval.py 的 _load_docs/_tree_summary/_result_filename_to_note_name。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tokenize } from "./tokenize.js";
import { MemoryBM25Backend } from "./backend.js";
import { getLogger } from "../logging.js";

const log = getLogger("retrieval");

export interface LoadedDoc {
  filename: string;
  filepath: string;
  tree: unknown;
  tokens: string[];
}

export interface RankedDoc extends LoadedDoc {
  noteName: string;
  score: number;
}

/** 递归提取 title/summary/prefix_summary/text 字段拼文档（_load_docs._extract）。 */
function extractTexts(node: unknown, texts: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) extractTexts(item, texts);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const key of ["title", "summary", "prefix_summary", "text"]) {
      const v = obj[key];
      if (v) texts.push(String(v));
    }
    if ("nodes" in obj) extractTexts(obj["nodes"], texts);
    if ("structure" in obj) extractTexts(obj["structure"], texts);
  }
}

/** 启动时全量加载 results JSON。
 *  解析失败的文件跳过并 debug 记录——这是与外部系统（既有混合产物目录）的兼容层，
 *  半个 JSON / 非产物杂文件不应让整个查询崩掉（CLAUDE.md 允许的兼容层 fallback）。 */
export function loadDocs(resultsDir: string): LoadedDoc[] {
  const docs: LoadedDoc[] = [];
  if (!existsSync(resultsDir)) return docs;
  for (const name of readdirSync(resultsDir).sort()) {
    if (!name.endsWith(".json")) continue;
    const filepath = join(resultsDir, name);
    try {
      const tree: unknown = JSON.parse(readFileSync(filepath, "utf-8"));
      const texts: string[] = [];
      extractTexts(tree, texts);
      const tokens = tokenize(texts.join(" "));
      if (tokens.length) docs.push({ filename: name, filepath, tree, tokens });
    } catch (e) {
      log.debug(`skip ${name}: ${String(e)}`);
    }
  }
  return docs;
}

/** 产物文件名 → 笔记名 stem：'folder__sub__My_Note_structure.json' → 'My_Note' */
export function resultFilenameToNoteName(filename: string): string {
  const stem = filename.endsWith("_structure.json")
    ? filename.slice(0, -"_structure.json".length)
    : filename;
  return stem.split("__").pop() as string;
}

/** 文档树骨架（id/title/summary 压缩 JSON），供 stage-2 prompt。 */
export function treeSummary(tree: unknown): string {
  function s(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(s);
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const r: Record<string, unknown> = {};
      if ("node_id" in obj) r["id"] = obj["node_id"];
      if ("title" in obj) r["title"] = obj["title"];
      if ("summary" in obj) r["summary"] = obj["summary"];
      if (obj["nodes"]) r["nodes"] = s(obj["nodes"]);
      if (obj["structure"]) r["structure"] = s(obj["structure"]);
      return r;
    }
    return node;
  }
  return JSON.stringify(s(tree));
}

/** node_id → 节点 的扁平映射（get_node_map）。 */
export function nodeMap(tree: unknown): Map<string, Record<string, unknown>> {
  const mapping = new Map<string, Record<string, unknown>>();
  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if ("node_id" in obj) mapping.set(String(obj["node_id"]), obj);
      if ("nodes" in obj) walk(obj["nodes"]);
      if ("structure" in obj) walk(obj["structure"]);
    }
  }
  walk(tree);
  return mapping;
}

/** stage-1：BM25 排序 top-k（canopy find；search 的候选集）。 */
export function findDocs(resultsDir: string, query: string, topK: number): RankedDoc[] {
  const docs = loadDocs(resultsDir);
  if (!docs.length) return [];
  const backend = new MemoryBM25Backend();
  for (const d of docs) backend.upsert({ id: d.filename, tokens: d.tokens });
  const byId = new Map(docs.map((d) => [d.filename, d]));
  return backend.query(tokenize(query), topK).map(({ id, score }) => {
    const d = byId.get(id) as LoadedDoc;
    return { ...d, noteName: resultFilenameToNoteName(id), score };
  });
}
