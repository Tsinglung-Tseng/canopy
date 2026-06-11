# mcp — query-only stdio MCP server

状态：设计完成（未开始编码）

## 职责

`canopy mcp --corpus <name>`：给 Claude Code 等 MCP 客户端提供检索工具。**只查询，不监听，不落盘日志**——这是对 molly.pageindex mcp_server.py 事故的直接架构回应（每 session 一实例 × 实例带 watcher + FileHandler = 1.4 GB）。N 个 session 起 N 个实例无任何共享状态冲突。

## 工具面（对齐现有 pageindex MCP，迁移即指针切换）

| tool | 行为 |
|---|---|
| `find_notes(query, top_k)` | stage-1 BM25，返回名称列表 |
| `search_notes(query, top_k, model?)` | 两阶段 + 答案合成 |
| `grep_notes(pattern, ...)` | 正则直扫 |
| `index_note(md_path)` | 手动单文件索引（保留：人在会话里改完笔记立即索引的真实需求） |

## 关键实现

- `@modelcontextprotocol/sdk` stdio transport。
- stdout 纯净纪律：所有日志走 stderr（TS 下无 Python print 污染问题，但第三方库 console.log 仍需 guard——入口处把 console 重定向到 stderr）。
- SDK 请求级日志钳到 warn（ADR-002 规则 3）。
- 启动时校验 corpus 可解析、LLM 凭据非空，缺失立即退出非 0（旧版"401 被吞成 no relevant nodes"教训，已在 2026-06-10 修过一轮，新实现保持 fail-loud）。

## 依赖

retrieval、llm、indexing、corpus、logging。

## 已知问题

- `index_note` 是 query-only 原则的唯一例外（写产物），保留理由：它是同步单次、用户显式触发，与常驻 watcher 的失控模式无关。
