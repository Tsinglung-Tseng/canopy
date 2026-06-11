# ADR-007 核心精简版切线（lean core scope）

## 背景

2026-06-11 对 molly.pageindex 全仓做了移植规模实测：全仓 5,369 行 Python，但其中约 60% 不属于"树状索引 + 两阶段检索"的核心能力（PDF 路线 1,153 行、web UI 905 行、MCP server 403 行、LLM client 236 行由 Plexus 替代）。若按 M0 路线图全量推进，核心能力要等到 M6/M7 才可用。

## 决策

首个可交付物定为**核心精简版**：markdown-only 的索引 + 检索 CLI，对应里程碑 M1–M5 的瘦身版。切线如下：

**进精简版**（实测移植清单，Python 有效逻辑 ≈ 950–1,100 行）：

| 移植对象 | Python 行数 | 去向 |
|---|---|---|
| `page_index_md.py`（md→树） | 341 | core |
| `retrieval.py`（BM25 + 两阶段） | 336 | retrieval + llm |
| `indexing.py`（规范名 + md5 增量） | 81 | indexing |
| `retrieve.py` 的 md 半边 | ~60 | core/cli |
| `utils.py` 被引用子集（token 计数等） | ~150–200 | core |

**不进精简版**：

- `page_index.py`（1,153，PDF 路线）——**永久排除**，Canopy 不做 PDF（readers 书库消费走既有产物，ADR-006 兼容覆盖）。
- `web_ui.py`（905）——永久排除，查询界面由 MCP/CLI 消费方自带。
- `mcp_server.py`（403）→ M6 重做（query-only，见 mcp.md）。
- `client.py`（236）+ `utils.py` 的 `llm_completion`/`extract_json` —— 不移植，Plexus `ask`/`askSchema` 替代（ADR-005）。
- batch 大循环、watch —— M5.5/M6 按模块文档重做，不从旧码移植。

**预期 TS 规模**：src ≈ 1.5k–2k 行（Python→TS 1.3–1.5× 膨胀），测试 ≈ 600–1,000 行。

## 风险登记（占工期不确定性的主体）

1. **golden 逐字节对照**：`tree_thinning_for_index` 依赖 tiktoken 计数，TS 用 js-tiktoken（同 BPE 编码文件，理论逐 token 一致）。若实测有偏差，golden 降级为去 summary 字段后的结构 deep-equal——降级是文档化决策，不算阻塞（core.md 已记录容忍点）。
2. **jieba-py vs `@node-rs/jieba` 分词差异**：影响 BM25 排序而非正确性，验收标准定为"排序近似一致"（top-k 重叠率），不追逐分一致。
3. **JSON 序列化格式**：Python `json.dumps` 与 JS `JSON.stringify` 的缩进/键序差异。产物要能混读混写（ADR-006），需要一个兼容序列化器——实现归 indexing 模块，估半天，易低估故显式登记。

## 理由

精简版让"能用的 canopy find/search"最早落地，M6+（MCP/watch/迁移）全部变成在可用核心上的增量；同时把全仓 60% 的非核心代码明确排除在移植范围外，避免"重写 = 全量搬家"的隐性范围蔓延。依赖全为成熟件（commander / @node-rs/jieba / js-tiktoken / chokidar / vitest），无需回基座开发的元语缺口。
