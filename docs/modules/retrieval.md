# retrieval — 分词 + BM25 + 可插拔后端

状态：设计完成（未开始编码）

## 职责

检索 stage-1：把 corpus 的索引产物变成可打分文档集，BM25 排序出 top-k 候选，交给 [llm](llm.md) 的 stage-2。后端可插拔（ADR-003）。

## 架构

```
tokenize(text): string[]
  - lowercase；剥标点（含中文标点 ，。！？；：、""''（）【】《》）
  - CJK 串走 @node-rs/jieba 词级切分（不逐字！单字 IDF 刷分 bug 两个旧仓都修过，必须保住）
  - 其余按空白切

RetrievalBackend 接口：upsert(doc) / remove(id) / query(tokens, topK)
  MemoryBM25Backend  (M3)：启动时全量加载 results JSON，提取 title/summary/prefix_summary/text 字段拼文档
  SqliteFts5Backend  (M8)：持久化于 corpus 数据目录，增量更新
```

BM25 参数与旧实现严格一致：k1=1.5、b=0.75、IDF = ln(1 + (N - df + 0.5)/(df + 0.5))，分子 f×2.5（即 f×(k1+1)）。

## 接口

`findDocs(corpus, query, topK): RankedDoc[]`（纯 stage-1，对应 `canopy find`）
`loadDocSkeleton(doc): string`（id/title/summary 压缩 JSON，供 stage-2 prompt）

## 依赖

@node-rs/jieba；better-sqlite3（仅 M8 后端）。

## 测试策略

分词对照表（中英混排、单字陷阱用例如"红/黑/树"）；BM25 打分用固定小语料和 Python 版离线算出的期望分数对照（容差 1e-9）。

## 已知问题

- BM25 跨语言弱（中文 query 找英文书）是已知现状（vault 记忆 pageindex BM25 跨语言弱），readers 侧用翻译扩展 query 缓解；Canopy 首版不解决，留给 corpus 级 query 扩展或 M8+。
- score=0 截断行为保留（零分文档不进候选），空结果是正常返回不是错误（ADR-004 退出码语义）。
