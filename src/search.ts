// search — 两阶段检索编排：BM25 stage-1 → LLM stage-2（节点选择）→ 可选答案合成。
// 移植 molly.pageindex retrieval.py 的 search_notes_impl / search_notes_structured，
// LLM 调用全部经由 src/llm/（Plexus 原语）。
import type { Agent } from "./llm/kernel.js";
import { ok } from "./llm/kernel.js";
import type { SearchHit, NodeHit } from "./types/canopy.types.js";
import { findDocs, treeSummary, nodeMap } from "./retrieval/docs.js";
import { selectNodesForDocs, synthesizeAnswer } from "./llm/agents.js";

export interface SearchOpts {
  topK: number;
  /** stage-2 文档级并发上限（corpus.concurrency） */
  concurrency: number;
  /** 是否合成自然语言答案（--no-answer / --json 结构化模式跳过） */
  answer: boolean;
  lang: "en" | "zh";
}

export interface SearchOutput {
  results: SearchHit[];
  answer?: string;
}

const MAX_HITS_PER_DOC = 8; // Python search_notes_structured 的 node_ids[:8]

export function searchAgent(resultsDir: string, query: string, opts: SearchOpts): Agent<SearchOutput> {
  return async (ctx) => {
    const topDocs = findDocs(resultsDir, query, opts.topK);
    if (!topDocs.length) return ok({ results: [] });

    const skeletons = topDocs.map((d) => ({ filename: d.filename, skeleton: treeSummary(d.tree) }));
    const outcome = await selectNodesForDocs(query, skeletons, opts.concurrency)(ctx);
    if (!outcome.ok) return outcome;

    const results: SearchHit[] = [];
    const contexts: string[] = [];
    topDocs.forEach((doc, i) => {
      const sel = outcome.value[i];
      const ids = sel && sel.ok ? sel.value : []; // 失败已在 selectNodesOrEmpty 降级 + warn
      const nm = nodeMap(doc.tree);
      const hits: NodeHit[] = [];
      let ctxBlock = `--- From: ${doc.filename} ---\n`;
      let hasNode = false;
      for (const nid of ids.slice(0, MAX_HITS_PER_DOC)) {
        const n = nm.get(String(nid));
        if (!n) continue;
        // 对外部产物字段的宽容读（兼容层）：旧产物可能缺 summary/text
        const title = String(n["title"] ?? "Untitled");
        hits.push({
          node_id: String(nid),
          title: String(n["title"] ?? ""),
          summary: String(n["summary"] ?? n["prefix_summary"] ?? ""),
        });
        const content = String(n["text"] ?? n["summary"] ?? "");
        ctxBlock += `## ${title}\n${content}\n\n`;
        hasNode = true;
      }
      if (hasNode) contexts.push(ctxBlock);
      results.push({
        note_name: doc.noteName,
        filename: doc.filename,
        bm25_score: doc.score,
        hits,
      });
    });

    if (!opts.answer) return ok({ results });
    if (!contexts.length) {
      return ok({
        results,
        answer: "Found candidate documents but no relevant nodes matched the query.",
      });
    }
    const ans = await synthesizeAnswer(query, contexts.join("\n"), opts.lang)(ctx);
    if (!ans.ok) return ans;
    return ok({ results, answer: ans.value }, ans.cost);
  };
}
