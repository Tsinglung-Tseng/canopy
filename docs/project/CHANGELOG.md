# Canopy CHANGELOG

### 2026-06-11
- [decision] project: 立项。从 molly.pageindex 提炼为独立 TS CLI 工具库，命名 Canopy（Aquifer/石笋/Plexus 谱系）。语言选型 TS（vs Go/Rust，ADR-001）。
- [decision] logging: 日志三铁律成文（ADR-002），针对 mcp_server.log 1.4 GB 事故的结构性根因。
- [decision] retrieval: 索引后端可插拔，内存 BM25 起步、SQLite FTS5 做大文本集后端（ADR-003）。
- [decision] cli: 跨语言消费接口定为 CLI `--json` 子进程 + MCP，不提供 Python import（ADR-004）。
- [decision] scaffold: 基座消费方式——fsir 发 types（ir/canopy.tsp），Plexus 直接 import 无 sidecar（ADR-005）。
- [decision] indexing: 索引产物格式与 molly.pageindex `*_structure.json` 及规范名规则保持兼容，47 MB 既有索引零迁移（ADR-006）。
- [feature] docs: M0 文档奠基——dev-plan、10 篇模块设计文档、6 篇 ADR。
