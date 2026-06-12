// RetrievalBackend — 可插拔检索后端接口（ADR-003）。
// MemoryBM25Backend = M3 等价移植；SqliteFts5Backend = M8（大文本集路线）。
import { BM25 } from "./bm25.js";

export interface BackendDoc {
  /** 产物文件名（corpus 内唯一） */
  id: string;
  tokens: string[];
}

export interface ScoredDoc {
  id: string;
  score: number;
}

export interface RetrievalBackend {
  upsert(doc: BackendDoc): void;
  remove(id: string): void;
  /** BM25 排序 top-k；score=0 截断（零分文档不进候选）。 */
  query(tokens: string[], topK: number): ScoredDoc[];
}

/** 内存后端：全量持有 tokens，查询时（惰性）重建 BM25——语义等价旧实现的每查询全扫。 */
export class MemoryBM25Backend implements RetrievalBackend {
  private readonly docs = new Map<string, string[]>();
  private bm25: BM25 | null = null;
  private order: string[] = [];

  upsert(doc: BackendDoc): void {
    this.docs.set(doc.id, doc.tokens);
    this.bm25 = null;
  }

  remove(id: string): void {
    this.docs.delete(id);
    this.bm25 = null;
  }

  query(tokens: string[], topK: number): ScoredDoc[] {
    if (!this.docs.size) return [];
    if (!this.bm25) {
      this.order = [...this.docs.keys()];
      this.bm25 = new BM25(this.order.map((id) => this.docs.get(id) as string[]));
    }
    const scores = this.bm25.getScores(tokens);
    const ranked = this.order
      .map((id, i) => ({ id, score: scores[i] as number }))
      .sort((a, b) => b.score - a.score) // 稳定排序，平分保持加载序（与 Python sorted 一致）
      .filter((d) => d.score > 0);
    return ranked.slice(0, topK);
  }
}
