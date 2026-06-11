# ADR-003 检索后端可插拔：内存 BM25 起步，SQLite FTS5 做大文本集

## 背景

molly.pageindex 的检索是"每次查询全量读 results 目录所有 JSON → 内存重建 BM25 → 打分"。vault 几千篇没问题；外推到"更大的文本集"时这是第一个崩的点——O(corpus) 每查询，与语言无关。

## 选项

1. 保持内存全扫——简单，小 corpus 够用，大 corpus 崩。
2. 一步到位 SQLite FTS5——首版复杂度高，违背"不预先抽象"。
3. tantivy（Rust）——锁死语言选型，百万级才需要。
4. **可插拔接口，分阶段实现**。

## 决策

定义 `RetrievalBackend` 接口（最小面：`upsert(doc)` / `remove(id)` / `query(tokens, topK)`），两个实现：

- `MemoryBM25Backend`（M3）：等价移植现有实现——jieba 词级分词（CJK 走切词而非逐字，避免单字 IDF 刷分，与 molly.pageindex/readers 修过的 bug 对齐）、BM25 参数 k1=1.5/b=0.75。
- `SqliteFts5Backend`(M8)：索引持久化进 corpus 数据目录，增量 upsert，查询不再全量加载。

corpus 配置里 `backend: memory | sqlite` 显式选择，缺省 memory。

## 理由

接口先行的成本只有一个 interface 文件，不算预先抽象——两个实现的证据已经存在（vault 用 memory 足够；"更大文本集"是用户明说的外推目标）。FTS5 在 TS 生态成熟（better-sqlite3），无需引入第二语言。
