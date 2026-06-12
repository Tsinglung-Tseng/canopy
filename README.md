# Canopy 🌳

> **⚠️ 开发已迁移（2026-06-12）**：Canopy 已整体移植到
> [molly.pageindex](https://github.com/Tsinglung-Tseng/molly.pageindex) 作为其新实现，
> 后续开发在该仓进行；本仓冻结为开发历史存档（M0–M6 + 移植就绪全过程）。

树状文档索引 + 两阶段检索（BM25 → LLM tree search）的独立 CLI 工具库。从 molly.pageindex 提炼重写（TypeScript），以 **corpus** 为一等抽象，一套工具服务任意文本集（Obsidian vault、书库、更大的外部文本集）。

> 命名谱系：Aquifer（含水层）· 石笋（fullStackIR）· Plexus（神经丛）→ **Canopy**（树冠层），文档树的顶视图。

## 状态

M1–M6 已实现并完成端到端验证（2026-06-11）：core / retrieval / llm / corpus / indexing / cli / mcp / watch / logging 全模块落地，95 测试用例全绿，真实 corpus（RPG vault 3,821 产物）+ 真实 DeepSeek 两阶段检索验证通过。待办：M0.5 运维止血、M7 消费方迁移、M8 SQLite FTS5 后端。详见 [docs/project/dev-plan.md](docs/project/dev-plan.md)。

```bash
npm install && make ir-check && npm test   # 全部闸门
export CANOPY_CONFIG=...                   # 或 ~/.config/canopy/corpora.yaml
canopy corpora                             # 列出 corpus + 健康度
canopy find   --corpus vault "查询词"       # stage-1 BM25（无 LLM）
canopy search --corpus vault "查询词" --lang zh   # 两阶段 + 答案合成
canopy index  --corpus vault [--file x.md] # 增量索引
canopy mcp    --corpus vault               # query-only stdio MCP
canopy watch  --corpus vault               # 常驻 watcher（单实例）
```

## 文档地图

- **对外兼容承诺：`COMPATIBILITY.md`**（产物格式/规范名/CLI --json/MCP 工具面/配置键）
- 计划与里程碑：`docs/project/dev-plan.md`
- 变更时间线：`docs/project/CHANGELOG.md`
- 模块设计（10 篇）：`docs/modules/`
- 架构决策（ADR 001–008）：`docs/decisions/`
  - 001 语言选型 TS · 002 日志三铁律 · 003 检索后端可插拔
  - 004 跨语言 CLI `--json` 契约 · 005 基座消费（fsir + Plexus）· 006 索引格式兼容
  - 007 核心精简版切线（lean core scope）· 008 自带最小 LLM kernel（Plexus 可选注入）

## 基座

本仓是 [/scaffold 基座消费规范](~/.claude/skills/scaffold/SKILL.md) 的消费项目：

- **石笋 fullStackIR**：`ir/canopy.tsp` → emit `src/types/canopy.types.ts`（只读，golden 保护）
- **Plexus**：可选注入（ADR-008）——消费的原语子集已内联为 `src/llm/kernel.ts`，Plexus 后端实例可直接注入
