# Canopy 🌳

树状文档索引 + 两阶段检索（BM25 → LLM tree search）的独立 CLI 工具库。从 molly.pageindex 提炼重写（TypeScript），以 **corpus** 为一等抽象，一套工具服务任意文本集（Obsidian vault、书库、更大的外部文本集）。

> 命名谱系：Aquifer（含水层）· 石笋（fullStackIR）· Plexus（神经丛）→ **Canopy**（树冠层），文档树的顶视图。

## 状态

M0 — 设计文档阶段，尚未编码。从 [docs/project/dev-plan.md](docs/project/dev-plan.md) 开始读。

## 文档地图

- 计划与里程碑：`docs/project/dev-plan.md`
- 变更时间线：`docs/project/CHANGELOG.md`
- 模块设计（10 篇）：`docs/modules/`
- 架构决策（ADR 001–006）：`docs/decisions/`
  - 001 语言选型 TS · 002 日志三铁律 · 003 检索后端可插拔
  - 004 跨语言 CLI `--json` 契约 · 005 基座消费（fsir + Plexus）· 006 索引格式兼容

## 基座

本仓是 [/scaffold 基座消费规范](~/.claude/skills/scaffold/SKILL.md) 的消费项目：

- **石笋 fullStackIR**：`ir/canopy.tsp` → emit `src/types/canopy.types.ts`（只读，golden 保护）
- **Plexus**：LLM 编排直接 import（ask / askSchema / par / Budget）
