// llm — Canopy 所有 LLM 调用的唯一出口，基于内核原语组合（ADR-005/ADR-008）。
// Python 旧实现的 llm_completion 手写 retry → ask；extract_json 正则修补 → askSchema；
// ThreadPoolExecutor → par；无 token 上限 → Budget fail-loud。
import { createHash } from "node:crypto";
import { ask, askSchema, par, ok, ZERO_COST } from "./kernel.js";
import type { Agent, Outcome } from "./kernel.js";
import type { DocStructure, TreeNode } from "../types/canopy.types.js";
import { structureToList } from "../core/tree.js";
import { countTokens } from "../core/tokens.js";
import { getLogger } from "../logging.js";

const log = getLogger("llm");

/** 单节点摘要：<阈值直接用原文（不调 LLM，零成本），否则 ask 生成。
 *  prompt 逐字保留 Python 版 generate_node_summary（生产验证过的措辞）。 */
export function summarizeNode(text: string, summaryTokenThreshold: number): Agent<string> {
  if (countTokens(text) < summaryTokenThreshold) {
    return async () => ok(text, ZERO_COST);
  }
  const prompt = `You are given a part of a document, your task is to generate a description of the partial document about what are main points covered in the partial document.

    Partial Document Text: ${text}

    Directly return the description, do not include any other text.
    `;
  return ask(prompt);
}

/** chunked par：把并发限制在 width 内（分批 barrier）。
 *  par 本身无限幅；这里用原语组合实现限幅。 */
function parChunked<A>(agents: Array<Agent<A>>, width: number): Agent<Array<Outcome<A>>> {
  return async (ctx) => {
    const all: Array<Outcome<A>> = [];
    let cost = ZERO_COST;
    for (let i = 0; i < agents.length; i += width) {
      const batch = await par(agents.slice(i, i + width))(ctx);
      if (!batch.ok) return batch as unknown as Outcome<Array<Outcome<A>>>;
      all.push(...batch.value);
      cost = {
        inputTokens: cost.inputTokens + batch.cost.inputTokens,
        outputTokens: cost.outputTokens + batch.cost.outputTokens,
        calls: cost.calls + batch.cost.calls,
      };
    }
    return ok(all, cost);
  };
}

/** 节点正文 → 既往 LLM 生成摘要的复用缓存（M8.5 节点级摘要复用）。
 *  键 = 正文 md5（node_id 是先序位置编号，插入/删除 heading 会整体偏移，不可作键；
 *  正文逐字相同才命中）。值 = 既往摘要字符串。 */
export type SummaryCache = Map<string, string>;

function textKey(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

/** 从既有产物构建复用缓存。仅收录"真烧过 LLM"的节点（summary/prefix_summary
 *  !== text）——阈值以下的原文摘要零成本可重算，不进缓存，避免阈值变更时把原文
 *  形态误当 LLM 摘要复用。叶/非叶不分：摘要是 text 的纯函数（summarizeNode 不看
 *  层级），故 leaf↔非leaf 转换仍可复用——只是落到 summary 还是 prefix_summary 由
 *  新树的层级决定（buildSummaries 赋值逻辑统一处理）。
 *  读 summary ?? prefix_summary 是兼容层对既有产物的容忍读：每节点至多一个摘要字段。 */
export function buildSummaryCache(prior: DocStructure): SummaryCache {
  const cache: SummaryCache = new Map();
  for (const n of structureToList(prior.structure) as unknown as TreeNode[]) {
    if (n.text === undefined) continue;
    const v = n.summary ?? n.prefix_summary;
    if (v === undefined || v === n.text) continue;
    cache.set(textKey(n.text), v);
  }
  return cache;
}

/** 全树摘要：先序节点列表 par 并发；叶节点写 summary、非叶写 prefix_summary
 *  （字段追加在键序末尾——与既有产物字节序一致，golden 钉死的事实格式）。
 *  任一节点摘要失败 → 整文档失败（fail loud，对齐 Python asyncio.gather 语义）。
 *  cache（M8.5）：正文 md5 命中且节点仍在 LLM 路径（≥阈值）→ 复用既往摘要、省一次
 *  调用；tagger 回写/frontmatter 小改触发的重索引不再全文档重生成摘要。 */
export function buildSummaries(
  doc: DocStructure,
  summaryTokenThreshold: number,
  cache?: SummaryCache,
): Agent<DocStructure> {
  return async (ctx) => {
    const nodes = structureToList(doc.structure) as unknown as TreeNode[];
    // 计数只对"长节点"（≥阈值、真烧 LLM 的）有意义：短节点拿原文当摘要、永远零调用，
    // 不该算进复用率分母（否则 33/41 这种数字会让人误以为还要补 8 次请求）。
    let longNodes = 0; // LLM 候选数
    let reused = 0; // 命中既往摘要、省下的调用
    const agents = nodes.map((n) => {
      if (n.text === undefined) {
        throw new Error(`buildSummaries: 节点 ${n.node_id} 缺 text——必须用 mdToTree({withText:true}) 的树`);
      }
      if (countTokens(n.text) < summaryTokenThreshold) {
        return summarizeNode(n.text, summaryTokenThreshold); // 短节点：原文，零成本
      }
      longNodes++;
      const hit = cache?.get(textKey(n.text));
      if (hit !== undefined) {
        reused++;
        return (async () => ok(hit, ZERO_COST)) as Agent<string>;
      }
      return summarizeNode(n.text, summaryTokenThreshold);
    });
    if (reused) {
      const reburn = longNodes - reused;
      const shortNodes = nodes.length - longNodes;
      log.info(
        `reuse: ${doc.doc_name} 长节点 ${longNodes}｜复用 ${reused}｜重烧 ${reburn}` +
          `（省 ${reused} 次 LLM；另 ${shortNodes} 个短节点本就零调用）`,
      );
    }
    const outcome = await par(agents)(ctx);
    if (!outcome.ok) return outcome as unknown as Outcome<DocStructure>;
    const failures: string[] = [];
    outcome.value.forEach((res, i) => {
      const node = nodes[i] as TreeNode;
      if (!res.ok) {
        failures.push(`${node.node_id}: ${res.reason}`);
        return;
      }
      if (node.nodes && node.nodes.length) node.prefix_summary = res.value;
      else node.summary = res.value;
    });
    if (failures.length) {
      return { ok: false, reason: `摘要失败 ${failures.length}/${nodes.length} 节点：${failures.slice(0, 3).join("; ")}`, cost: outcome.cost };
    }
    return ok(doc, outcome.cost);
  };
}

const NODE_IDS_SCHEMA = {
  type: "object",
  properties: {
    node_ids: { type: "array", items: { type: "string" } },
  },
  required: ["node_ids"],
  additionalProperties: false,
} as const;

/** 检索 stage-2：给定 query + 文档树骨架，返回相关 node_id 数组。
 *  askSchema 强制结构化，彻底替代 Python extract_json 正则修补。 */
export function selectRelevantNodes(
  query: string,
  docSkeleton: string,
): Agent<{ node_ids: string[] }> {
  const prompt =
    `You are a smart search assistant. Given the following document tree structure ` +
    `(with node IDs, titles, and summaries), determine which nodes are most relevant ` +
    `to the user's query.\n\n` +
    `User Query: "${query}"\n\n` +
    `Document Tree:\n${docSkeleton}\n\n` +
    // "JSON" 一词必须出现：DeepSeek json_object 模式要求 prompt 含 "json" 字样，
    // 否则 400 降级往返（实测 2026-06-12）。
    `Return the node IDs that contain information relevant to answering the query ` +
    `as JSON: {"node_ids": ["0001", "0005"]}. If none are relevant, return {"node_ids": []}.`;
  return askSchema<{ node_ids: string[] }>(prompt, NODE_IDS_SCHEMA, {
    validate: (raw) => {
      const obj = raw as Record<string, unknown>;
      if (!obj || !Array.isArray(obj["node_ids"])) throw new Error("node_ids 缺失或非数组");
      return { node_ids: (obj["node_ids"] as unknown[]).map(String) };
    },
  });
}

/** stage-2 失败按文档降级为空命中（与 Python `except → node_ids=[]` 对齐——
 *  单文档选择失败不应让整次检索崩，记 warn）。 */
export function selectNodesOrEmpty(
  query: string,
  docSkeleton: string,
  filename: string,
): Agent<string[]> {
  const inner = selectRelevantNodes(query, docSkeleton);
  return async (ctx) => {
    const res = await inner(ctx);
    if (!res.ok) {
      log.warn(`stage2 failed for ${filename}: ${res.reason}`);
      return ok([] as string[], res.cost);
    }
    return ok(res.value.node_ids, res.cost);
  };
}

/** 多文档 stage-2，文档级并发 ≤ concurrency（沿用现行经验值，corpus 配置可调）。 */
export function selectNodesForDocs(
  query: string,
  docs: Array<{ filename: string; skeleton: string }>,
  concurrency: number,
): Agent<Array<Outcome<string[]>>> {
  return parChunked(
    docs.map((d) => selectNodesOrEmpty(query, d.skeleton, d.filename)),
    concurrency,
  );
}

/** 答案合成（search 命令 answer 模式）。prompt 逐字保留 Python 版。 */
export function synthesizeAnswer(query: string, context: string, lang: "en" | "zh"): Agent<string> {
  const langInstruction = lang === "zh" ? "请用中文回答。" : "Please answer in English.";
  const prompt =
    `You are a helpful assistant. Use the following excerpted information from ` +
    `my personal notes to answer the question. ${langInstruction}\n` +
    `If the information provided is not sufficient, state that clearly.\n\n` +
    `Question: ${query}\n\n` +
    `Reference Material:\n${context}\n\nAnswer:`;
  return ask(prompt);
}
