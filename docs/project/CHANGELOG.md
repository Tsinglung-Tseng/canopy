# Canopy CHANGELOG

### 2026-06-12（开源移植就绪）
- [decision] llm: ADR-008——解开源阻断项 `"plexus": "file:../Plexus"`：Canopy 实际消费的 Plexus 原语子集内联为零依赖 `src/llm/kernel.ts`（Cost/Outcome/Budget/ask/askSchema/par/run）+ `openai.ts`（零 SDK OpenAI-compatible 后端，schema 三模式保留）+ `mock.ts`（MockLlm）。`Llm` 接口为 Plexus 的结构子集，Plexus 后端实例可直接注入（可选增强）；package.json 不再含 plexus。95 用例全绿 + 真 DeepSeek e2e（batch 索引 + 中文两阶段检索）复验。
- [fix] llm: stage-2 prompt 补 "JSON" 一词——DeepSeek json_object 模式要求 prompt 含 "json" 字样，否则每次 stage-2 仍发生一次 400 降级往返；修后零降级。
- [test] core: 解开源阻断项「fixture 含个人笔记」——16 对真实 vault fixture 移至已 gitignore 的 test/fixtures-local/（`CANOPY_LOCAL_FIXTURES=1` 门控附加运行，CI/外部贡献者自动跳过）；入仓替换为 12 对全合成 fixture（中文名/多级 heading/跳级/代码块伪标题/未闭合 fence/frontmatter/无标题/单行/空文件/标题密集/大文件/规范名形态），golden 仍由 Python 原版 md_to_tree 生成（scripts/gen-synthetic-fixtures.py，跨实现对照语义不变）。cli/daemon 测试改显式点名 fixture（去目录序隐式依赖）。门控全开 29 用例绿（12 合成 + 16 真实 + 计数）。

### 2026-06-11（M1–M6 实现 + e2e）
- [feature] scaffold: M1——package.json/tsconfig/Makefile；`ir/canopy.tsp`（TreeNode/DocStructure/CorpusConfig + namespace Api 输出契约）→ ts-obj emit `src/types/canopy.types.ts`，golden 钉死，`make ir-check` 闸。
- [feature] core: M2——mdToTree 纯函数移植（heading 状态机/文本切片/thinning/栈式建树/键序 formatStructure）。golden 全量对照：4005 源中 2319 个未漂移源 100% 逐字段全等；16 fixture 进 test/。
- [fix] core: 实测修订设计认知——生产事实格式为 node_id 1-based（write_node_id 因 run_pageindex.py None 覆盖 bug 从未执行）、产物保留 text、summary 键序在末尾。mdToTree 按事实格式实现（ADR-006 兼容契约以 golden 为准）。
- [feature] retrieval: M3——tokenize（jieba-rs 词级，标点集逐字符对齐 Python）+ BM25（参数/分数 1e-9 级对照）+ RetrievalBackend 接口 + MemoryBM25Backend。top-5 重叠率 97%（8 条历史 query vs Python 版）。
- [feature] llm: M4——Plexus 接入：summarizeNode/buildSummaries（par+ask，阈值下原文零调用）、selectRelevantNodes（askSchema 强制 {node_ids}，单文档失败降级空命中）、synthesizeAnswer；Budget fail-loud；MockLlm 确定性测试。
- [feature] corpus: M5——corpora.yaml 解析（CANOPY_CONFIG > ~/.config/canopy/；${VAR} 未定义即崩；未知键报错；source.dir/llm 三字段/重名校验）。
- [feature] indexing: M5——规范名直写（无裸名中间态）、md5 状态侧车增量、既有产物收养（47MB 零重建）、原子写（.tmp+rename）、兼容序列化（JSON.stringify(x,null,2) 与 Python 逐字节 roundtrip 实测）、批量失败隔离（fail loud at end）、孤儿清理。
- [feature] cli: M5——canopy index/batch/find/search/grep/corpora/watch/mcp；--json 单文档 stdout 纯净；退出码 0（含零命中）/1/2；cost 摘要进 stderr。
- [feature] logging: M5——三铁律实现（库不落盘/落盘强制 10MB×3 轮转/降噪内建）；强约束 grep 检查点全过；轮转行为测试。
- [feature] mcp: M6——query-only stdio MCP（find_notes/search_notes/grep_notes/index_note），console 重定向 stderr，启动 fail-loud；stdio JSON-RPC 协议级测试含 stdout 纯净断言。
- [feature] watch: M6——chokidar 点目录前置过滤 + per-path debounce + last-write-wins 版本队列 + 热循环熔断（60s>10 次→熔断 10min）+ md5 跳过；进程级 e2e。
- [feature] config: llm.schema 可选字段（json_schema|json_object|off → Plexus OpenAICompatOpts.schema）；DeepSeek 配 json_object 省 stage-2 的 400 降级往返。
- [test] e2e: 真实 RPG 语料 find 与 Python 一致；真实 DeepSeek 两阶段 search + 中文合成；真实 LLM 索引（700 行/4 calls）；增量二跑全 skip；Python verbatim 检索代码消费 TS 产物 PASS。95 用例 / 9 文件全绿。

### 2026-06-11
- [decision] project: 立项。从 molly.pageindex 提炼为独立 TS CLI 工具库，命名 Canopy（Aquifer/石笋/Plexus 谱系）。语言选型 TS（vs Go/Rust，ADR-001）。
- [decision] logging: 日志三铁律成文（ADR-002），针对 mcp_server.log 1.4 GB 事故的结构性根因。
- [decision] retrieval: 索引后端可插拔，内存 BM25 起步、SQLite FTS5 做大文本集后端（ADR-003）。
- [decision] cli: 跨语言消费接口定为 CLI `--json` 子进程 + MCP，不提供 Python import（ADR-004）。
- [decision] scaffold: 基座消费方式——fsir 发 types（ir/canopy.tsp），Plexus 直接 import 无 sidecar（ADR-005）。
- [decision] indexing: 索引产物格式与 molly.pageindex `*_structure.json` 及规范名规则保持兼容，47 MB 既有索引零迁移（ADR-006）。
- [feature] docs: M0 文档奠基——dev-plan、10 篇模块设计文档、6 篇 ADR。
- [decision] project: 核心精简版切线（ADR-007）——首个交付物为 M1–M5 瘦身版（markdown-only 索引+检索 CLI），移植清单实测 ≈1,100 行 Python 有效逻辑，PDF/web UI 永久排除；tiktoken/jieba/JSON 序列化三风险登记对策与验收标准。
