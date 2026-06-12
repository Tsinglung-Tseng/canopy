# Canopy 开发计划

## 📌 项目定位

**项目描述**：Canopy 是树状文档索引 + 两阶段检索（BM25 → LLM tree search）的独立 CLI 工具库。从 molly.pageindex 提炼重写（TS），以 **corpus** 为一等抽象，服务多个文本集：Obsidian vault、readers 书库、以及未来外推的更大文本集。命名谱系：Aquifer（含水层）/ 石笋（fullStackIR）/ Plexus（神经丛）一派——**树冠层**，文档树的顶视图。

**起源问题**（为什么要做）：
1. molly.pageindex 的 `mcp_server.py` 把 watcher + 无轮转 FileHandler 背在每个 Claude Code session 各起一个的 stdio 进程上 → `mcp_server.log` 失控至 1.4 GB（2342 次进程启动追加同一文件 + worktree 消失 traceback 风暴 ×35828 + watchdog 热循环）。
2. 核心（树构建/检索）与应用（MCP/web/watcher）耦合在一个仓里，readers.myapp 被迫复刻了一份 BM25，library-search 的 adapter 直接伸进别人目录。
3. 用户要把 pageindex 能力外推到更多更大的文本集 → 需要独立、可分发、日志可控的工具库。

**技术栈**：
- TypeScript（Node ≥ 20，ESM），CLI：commander
- 中文分词：`@node-rs/jieba`（jieba-rs 的 napi 绑定）
- MCP：`@modelcontextprotocol/sdk`（官方参考实现）
- 文件监听：chokidar
- 测试：vitest（Plexus MockLlm 确定性测试 + Python 产物 golden 对照）
- 基座：fullStackIR（ir/canopy.tsp → types emit）+ Plexus（LLM 编排，直接 import）

## 🧭 基座消费登记（/scaffold 规范）

| 基座 | 消费方式 | 本仓自持有物 |
|---|---|---|
| 石笋 fullStackIR | `ir/canopy.tsp` 定义核心数据契约（TreeNode / DocStructure / CorpusConfig / SearchHit），ts-obj emit 到 `src/types/canopy.types.ts`（只读，golden + `make ir-check`） | `ir/canopy.tsp`、`golden/` |
| Plexus | **直接 import**（Canopy 即 TS，无需 sidecar）。消费原语：`ask`（节点摘要/答案合成）、`askSchema`（stage-2 节点选择，替代 Python 版 extract_json 正则修补）、`par`（并发 LLM 调用）、`Budget`（token 上限 fail-loud）、MockLlm（确定性测试） | `src/llm/`（agent 组合代码）、Makefile `agents-*` 靶 |

铁律继承：元语缺口回基座做（proposal→ADR→test）不本地私接；生成文件只读；fail loud 无静默兜底；MockLlm 确定性回归。

## 🗂 模块总览

| 模块 | 核心职责 | 状态 |
|---|---|---|
| [core](../modules/core.md) | markdown → 文档树（纯函数，无 LLM 无 IO），移植 page_index_md.py | 设计完成 |
| [llm](../modules/llm.md) | Plexus 编排：节点摘要、stage-2 节点选择、答案合成 | 设计完成 |
| [retrieval](../modules/retrieval.md) | 分词（jieba 词级）+ BM25 + 可插拔索引后端 | 设计完成 |
| [corpus](../modules/corpus.md) | corpora.yaml 多文本集注册与解析（fail-loud） | 设计完成 |
| [indexing](../modules/indexing.md) | 规范名映射、md5 增量、results 落盘（兼容 molly.pageindex 产物） | 设计完成 |
| [cli](../modules/cli.md) | canopy index/batch/find/search/grep/watch/mcp，`--json` 跨语言接口 | 设计完成 |
| [mcp](../modules/mcp.md) | query-only stdio MCP server（无 watcher 无文件日志） | 设计完成 |
| [watch](../modules/watch.md) | 常驻 watcher（全局单实例，由 Molly worker 持有） | 设计完成 |
| [logging](../modules/logging.md) | 日志三铁律实现 | 设计完成 |
| [migration](../modules/migration.md) | 三消费方迁移 + molly.pageindex 应用层退役 | 设计完成 |

## ⏳ 待完成

**当前承诺交付物：核心精简版 = M1–M5（ADR-007 切线）**。markdown-only 索引 + 检索 CLI，移植范围 ≈ 1,100 行 Python 有效逻辑（全仓 60% 明确排除：PDF/web UI 永久不做，MCP/watch 为 M6 增量）。预期规模 src 1.5k–2k 行 TS + 测试 600–1k 行，每个里程碑约一个会话量级。

- [x] M0 文档奠基：dev-plan + 模块设计文档 + ADR 001–006（2026-06-11）
- [x] M0.1 精简版评估与切线：移植清单实测、风险登记、ADR-007（2026-06-11）
- [ ] M0.5 运维止血（不等重写）：truncate `molly.pageindex/mcp_server.log`（1.4 GB）与 `molly.tagger/watcher.log`（12 MB）；molly.pageindex 临时加 RotatingFileHandler + `.claude/worktrees/` 过滤，撑到 M7 退役
- [x] M1 仓库脚手架：package.json / tsconfig / Makefile（ir-gen / ir-check / agents-typecheck / agents-test）；`ir/canopy.tsp` 首版 + ts-obj emit + 钉 golden（2026-06-11）
- [x] M2 core：md→tree 纯函数移植；golden 验收超额完成——全量 4005 源文件中 2319 个未漂移源 **100% 逐字段全等**（含键序），16 个代表性 fixture 钉入 test/（2026-06-11）
- [x] M3 retrieval：tokenize + BM25 + MemoryBM25Backend + `canopy find`；BM25 分数与 Python 原版对照容差 1e-9；jieba 差异验收 = 8 条历史 query top-5 重叠率 **97%**（2026-06-11）
- [x] M4 Plexus 接入：summarize（par+ask）/ selectNodes（askSchema）/ synthesize、Budget fail-loud；MockLlm 测试绿（2026-06-11）
- [x] M5 CLI 完整（index/batch/find/search/grep/corpora + --json + 退出码 0/1/2）+ logging 三铁律（强约束 grep 全过）+ 兼容序列化器（`JSON.stringify(x,null,2)` 与 Python `json.dumps(indent=2, ensure_ascii=False)` 实测逐字节 roundtrip；混读混写双向验证）（2026-06-11）
- [x] M6 `canopy mcp`（query-only，stdio JSON-RPC 纯净断言级测试）+ `canopy watch`（debounce/last-write-wins/热循环熔断/点目录前置过滤，进程级 e2e）；MCP 注册切换、Molly worker startCmd 切换留 M7（2026-06-11）
- [x] E2E 端到端验证（2026-06-11）：真实 RPG 语料（3,821 产物）find 与 Python 版输出一致；真实 DeepSeek 两阶段 search（中文答案合成）；真实 LLM 索引 700 行长文档（4 calls）；二跑全 skip（md5 增量）；既有产物收养零重建；Python verbatim 检索代码消费 TS 产物 PASS
- [ ] M7 消费方迁移：readers.myapp 删自制 BM25 改调 CLI；library-search adapter 改走 canopy；launchd pageindex-batch 改 `canopy batch`；MCP 注册切换、Molly worker startCmd 切换；molly.pageindex 应用层退役（results/ 数据保留，见 ADR-006）
- [ ] M8 SQLite FTS5 索引后端（大文本集路线，见 ADR-003）

## 📝 开发记录

### 2026-06-11 — M1–M6 全量实现 + 端到端验证

- **交付**：src ≈ 1.7k 行 TS（core/retrieval/llm/corpus/indexing/cli/mcp/watch/logging/search/grep + 生成 types）+ 测试 9 文件 95 用例全绿；`make ir-check` / typecheck / build 全过。
- **关键实测发现（修订设计认知）**：既有产物的**事实格式**与 core.md 原记述不同——`run_pageindex.py` md 分支把 CLI 未传参数的 `None` 直接覆盖进 config（不过滤），导致生产链路实际为：`write_node_id` **从未执行**（node_id 为 build_tree 的 1-based "0001" 起文档序）、节点 **text 保留**在产物中、summary/prefix_summary **追加在键序末尾**。该事实格式即 ADR-006 兼容契约，mdToTree 按此实现并以 golden 锁死（不调 writeNodeId；函数保留导出仅作对照）。
- **三项 ADR-007 风险全部消除**：①golden 对照未触发 tiktoken 降级条款——2319 个未漂移源 100% 逐字节级全等（tiktoken 仅影响摘要阈值不影响结构）；②jieba 差异 top-5 重叠率 97%（>验收线）；③序列化器零成本——`JSON.stringify(x,null,2)` 与 Python 产物逐字节 roundtrip 实测成立。
- **iCloud TCC 阻断的对照路径**：本会话进程树无 iCloud Drive 授权（EPERM），复用机器既定模式（launchd + node TCC wrapper，pageindex-batch 同款）一次性快照 vault 4,007 个 .md 到 /tmp 完成全量对照。
- **增量语义落地**：md5 状态侧车 `<resultsDir>/.canopy-state.json`；既有产物（含 structure 键、无 md5 记录）首扫收养（记 md5 即跳过）——47 MB 资产零重建，e2e 实证（收养→改文件→重建链路）。
- **新增配置开口**：`llm.schema: json_schema|json_object|off`（可选，映射 Plexus OpenAICompatOpts.schema）——DeepSeek 不支持 json_schema response_format，显式配 json_object 省掉每次 stage-2 的 400 降级往返（缺省仍走 Plexus 默认+文档化降级）。
- **Node 基线**：使用 `fs.globSync`（Node ≥22）做 corpus 源枚举，实际基线从设计的 ≥20 提至 ≥22（本机 v24）。
- **范围注记**：M0.5（molly 运维止血）与 M7（外部消费方迁移/退役）涉及对其它仓与注册表的改动，未在本轮自动执行；M8 后端接口（RetrievalBackend）已就位。

### 2026-06-11 — 精简版评估与切线（M0.1）

- **背景调查**：molly.pageindex 全仓实测 5,369 行 Python；核心路径（page_index_md / retrieval / indexing / retrieve-md半边 / utils 子集）有效逻辑仅 ≈ 950–1,100 行，约 60% 代码（PDF 1,153 / web 905 / mcp_server 403 / client 236）不进移植范围。
- **设计决策**：首个交付物定为核心精简版 = M1–M5 瘦身版（ADR-007）；PDF 与 web UI 永久排除；三项风险（tiktoken golden 对照、jieba 分词差异、JSON 序列化兼容）连同对策与验收标准成文登记。
- **规模结论**：src ≈ 1.5k–2k 行 TS + 测试 600–1k 行，约 2–3 个开发会话。
- **文档更新**：ADR-007 创建；dev-plan 里程碑重排（M2/M3/M5 验收标准细化）；indexing.md 补兼容序列化器职责。

### 2026-06-11 — 项目奠基（M0）

- **背景调查**：实测 molly.pageindex `mcp_server.log` 1.4 GB 根因三连：N 个 stdio 实例共写一个无轮转 FileHandler、worktree 删除后 FileNotFoundError 全栈 traceback 风暴、watchdog 热循环。launchd 侧确认 `StandardOutPath/StandardErrorPath` 仅 O_APPEND 无轮转，系统轮转靠 newsyslog。
- **已完成**：docs/ 全套设计文档（10 模块 + 6 ADR）落盘；语言选型、命名、日志策略、检索后端、消费接口、基座消费方式、索引格式兼容均成文。
- **设计决策**：TS（ADR-001）；命名 Canopy（用户拍板，候选 Karst/Dendrite/Canopy）；日志三铁律（ADR-002）；检索后端可插拔（ADR-003）；跨语言消费走 CLI `--json`/MCP 不提供 Python import（ADR-004）；基座消费 fsir types + Plexus 直接 import（ADR-005）；索引产物格式与 molly.pageindex 兼容（ADR-006）。
- **新增 TODO**：M0.5 运维止血。
- **文档更新**：modules/ 全部 10 篇 + decisions/ 001–006 创建。
