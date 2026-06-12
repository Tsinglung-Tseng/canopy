# migration — 消费方迁移与旧仓退役

状态：部分完成（2026-06-12）——✅ MCP 注册 / launchd batch / Molly worker 三指针已切换至 canopy；
⏳ 待办：readers.myapp 迁移（现以软链 books corpus 只读过渡）、library-search adapter 迁移、
pageindex/ 包退役（上述两家迁完后并入 legacy/）

## 迁移总表

| 消费方 | 现状 | 迁移后 | 步骤 |
|---|---|---|---|
| Claude Code MCP 注册（`pageindex`，user scope 双份） | molly.pageindex/mcp_server.py（带 watcher + 1.4 GB 日志） | `canopy mcp --corpus vault` | M6：`claude mcp add-json` 换 command；工具名/签名兼容（mcp.md），零调用方改动 |
| Molly worker（config.json watchers[2] "Pageindex (Web)"） | `uv run python main.py`（web supervisor） | `canopy watch --corpus vault`（web UI 是否保留另议，见下） | M6：改 startCmd/startCwd |
| launchd `com.<user>.pageindex-batch`（03:00） | pageindex-batch.sh → batch_index.py | `canopy batch --corpus vault` | M7：改入口脚本一行（保留 launchd-tcc-wrapper 链路） |
| readers.myapp | editable 依赖 molly.pageindex；自制 BM25 副本；llm_cache 包 LLM 调用 | spawn `canopy index --file <md> --json` 建树；spawn `canopy find/search --json` 检索；删 `src/search.py` 的 BM25 类 | M7：pyproject 删 path 依赖；llm_cache 缺口见 llm.md 已知问题 |
| library-search | VaultAdapter/ReadersAdapter 直接读别人目录 + import molly.pageindex 内部函数 | adapter 改 spawn `canopy search --corpus X --json` | M7：adapter 改写；libraries.yaml 的 pageindex_root 等字段换成 corpus 名 |

## 退役清单（M7 完成后）

- molly.pageindex 应用层（mcp_server.py / main.py / batch_index.py / retrieval.py / indexing.py / web_ui.py）归档；`results/` 数据保留原位（vault corpus 的 resultsDir 指着它，ADR-006）。
- 删除 `~/.claude.json` 双份 pageindex 注册中的旧 command。
- 确认 `mcp_server.log` 不再增长后删除。

## 风险与开口

- **web UI**：main.py 的 uvicorn web 界面用户是否还在用？M6 前确认；若在用，Canopy 不复刻（不在 CLI 工具库职责内），让 web UI 独立成 molly.pageindex 残留小服务或直接砍。
- **readers llm_cache**：迁移后建树不再走 readers 的 LLM 缓存库。readers 建树是低频批量（每周），可接受真调；若费用敏感再回 Plexus 提 cache seam proposal。
- **双注册之谜**：`~/.claude.json` 里 pageindex 注册出现两次（user + 项目同名），迁移时一并清理。

## 验收（M7 闸）

1. `claude` 新 session 里 `find_notes`/`search_notes` 返回与旧版可比结果（抽 5 个历史 query 对照）。
2. Molly 日志面板能看到 canopy watch 的启动行；改一篇笔记 → debounce 后产物 JSON mtime 更新。
3. 24h 观察：`~/scaffold` 下无任何新增 >10 MB 日志文件（`find ~/scaffold -name '*.log' -size +10M`）。
4. readers `run_weekly.sh` 全程绿；library-search `search_libraries` 双库联邦查询绿。
