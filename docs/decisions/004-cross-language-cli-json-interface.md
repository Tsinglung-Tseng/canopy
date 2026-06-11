# ADR-004 跨语言消费接口：CLI `--json` 子进程 + MCP，不提供 Python import

## 背景

现有消费方两个是 Python：readers.myapp（editable path 依赖 molly.pageindex，import `md_to_tree`，并自己复刻了 BM25）、library-search（adapter 直接伸进 molly.pageindex / readers 的目录读文件）。核心改 TS 后 Python import 路径不复存在，必须定义新的消费契约。

## 选项

1. 维持双实现（Python 核心 + TS 核心）——双倍维护，漂移必然。
2. napi/wasm 给 Python 提供绑定——工程开销大，收益存疑。
3. **CLI 子进程 `--json` + MCP**：消费方 spawn `canopy <cmd> --json`，stdout 单 JSON 文档；或走 MCP tools。

## 决策

选 3。契约要点：

- 所有查询/索引命令支持 `--json`：stdout 只输出一个 JSON 文档（结构由 `ir/canopy.tsp` 的 `namespace Api` 定义并 emit 校验），人类可读输出走默认模式，日志一律 stderr——stdout 纯净是硬约束（MCP stdio 同款纪律）。
- 退出码：0 成功（含"零命中"——空结果不是错误）；非 0 = 真错误，stderr 给原因。
- 消费方迁移映射：readers.myapp 删自制 BM25 → spawn `canopy`；library-search adapter → spawn `canopy search --corpus X --json`（或直接降级为对 canopy MCP 的薄路由）。

## 理由

进程边界天然解耦语言；`--json` 契约由 fsir 同一 .tsp 发 ts types（canopy 侧自检）；子进程启动开销（~100ms node）对检索类调用可忽略。这也正是"独立 CLI 工具库"的本义：能力以命令行为单位外推，任何语言任何机器可消费。
