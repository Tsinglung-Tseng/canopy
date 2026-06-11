# ADR-001 语言选型：TypeScript

## 背景

Canopy 从 molly.pageindex（Python）提炼重写。候选：Go / Rust / TS。读核心代码后确认工作负载本质：**LLM 编排 + 异构 JSON 树搬运**——树构建是"按 heading 切分 → 节点并发调 LLM 生成摘要"，检索 stage-2 是"候选文档并发调 LLM 选节点"。全程 IO-bound，CPU 仅 BM25 打分与分词，量级小。瓶颈永远在等 LLM 返回。

## 选项

| 维度 | TS | Go | Rust |
|---|---|---|---|
| MCP SDK | 官方参考实现 | 官方 SDK 较新 | rmcp 较新 |
| jieba | `@node-rs/jieba`（底层即 jieba-rs） | gojieba（cgo，维护一般） | jieba-rs 最佳 |
| 异构 JSON 树 | 天然主场 | `map[string]any` 痛苦 | serde_json::Value 啰嗦 |
| 单二进制分发 | 需 node（bun compile 可补） | 最强 | 强 |
| 用户周边栈 | OpenClaw/HyperFrames/TypeSpec 全 TS 系 | 无 | 无 |

- Go 的牌：单二进制分发。代价：MCP/LLM 生态二线，JSON 树移植最别扭。
- Rust 的牌：tantivy（Lucene 级全文索引）。仅当明确做百万级文档自托管搜索时反超。

## 决策

TypeScript（Node ≥ 20，ESM）。

## 理由

1. 工作负载是 TS 主场；性能瓶颈不在语言。
2. MCP TS SDK 是参考实现；Plexus 基座即 TS，直接 import 零 sidecar（见 ADR-005）。
3. `@node-rs/jieba` 在 TS 里拿到 Rust 级分词。
4. 大文本集的 scaling 靠索引持久化（ADR-003），不靠语言；SQLite FTS5 三种语言都好用，TS + FTS5 已覆盖绝大多数场景。
5. 与用户现有基建同一工具链，开发速度最快。
