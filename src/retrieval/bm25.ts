// BM25 — 移植 molly.pageindex retrieval.py:_BM25，参数与旧实现严格一致：
// k1=1.5、b=0.75、IDF = ln(1 + (N - df + 0.5)/(df + 0.5))、分子 f×2.5（即 f×(k1+1)）。
export class BM25 {
  private readonly corpusSize: number;
  private readonly avgdl: number;
  private readonly docFreqs: Array<Map<string, number>> = [];
  private readonly idf = new Map<string, number>();
  private readonly docLen: number[] = [];

  constructor(corpus: string[][]) {
    this.corpusSize = corpus.length;
    this.avgdl = this.corpusSize
      ? corpus.reduce((s, d) => s + d.length, 0) / this.corpusSize
      : 1;
    for (const doc of corpus) {
      this.docLen.push(doc.length);
      const freq = new Map<string, number>();
      for (const w of doc) freq.set(w, (freq.get(w) ?? 0) + 1);
      this.docFreqs.push(freq);
      for (const w of freq.keys()) this.idf.set(w, (this.idf.get(w) ?? 0) + 1);
    }
    for (const [w, df] of this.idf) {
      this.idf.set(w, Math.log(1 + (this.corpusSize - df + 0.5) / (df + 0.5)));
    }
  }

  getScores(query: string[]): number[] {
    const scores = new Array<number>(this.corpusSize).fill(0);
    for (const q of query) {
      const qIdf = this.idf.get(q);
      if (!qIdf) continue; // 0 或缺失都跳过（与 Python `if not q_idf` 一致）
      for (let i = 0; i < this.docFreqs.length; i++) {
        const f = (this.docFreqs[i] as Map<string, number>).get(q);
        if (f) {
          scores[i] =
            (scores[i] as number) +
            (qIdf * (f * 2.5)) / (f + 1.5 * (1 - 0.75 + (0.75 * (this.docLen[i] as number)) / this.avgdl));
        }
      }
    }
    return scores;
  }
}
