# cli — 命令行入口

状态：已实现（src/cli.ts，2026-06-11）

## 职责

唯一用户入口与跨语言消费契约（ADR-004）。commander 实现，`canopy` 单可执行。

## 命令面

```
canopy index  --corpus <name> [--file <path>] [--force]      # 单文件或整 corpus 增量
canopy batch  --corpus <name>                                 # = index 全量增量（launchd 用）
canopy find   --corpus <name> <query> [--top-k 5] [--json]    # stage-1 only，无 LLM
canopy search --corpus <name> <query> [--top-k 5] [--json] [--no-answer]  # 两阶段
canopy grep   --corpus <name> <pattern> [--json]              # 正则直扫源文件
canopy watch  --corpus <name>                                 # 常驻 watcher（单实例）
canopy mcp    --corpus <name>                                 # query-only stdio MCP
canopy corpora                                                # 列出已注册 corpus + 健康度
```

全局选项：`--log-file <path>`（落盘日志，强制轮转，ADR-002）、`--log-level`。

## 契约（硬约束）

- stdout 纯净：`--json` 模式 stdout 只有一个 JSON 文档；默认模式只有人类可读结果。日志、进度、Cost 摘要一律 stderr。
- 退出码：0 = 成功（含零命中）；1 = 运行错误；2 = 用法/配置错误（缺 corpus、缺环境变量等 fail-loud 类）。
- `--json` 输出结构 = `ir/canopy.tsp` namespace Api 类型（golden 保护）。

## 依赖

commander + 全部内部模块。

## 已知问题

- `canopy grep` 与 MCP grep_notes 同源实现，注意跳点目录（旧实现已修：worktrees 副本会让同一笔记重复命中）。
- node 启动 ~100ms：对 watch/mcp 常驻无影响；高频脚本化调用 find 时可接受，必要时后续提供 `--stdin-batch`（无证据前不做）。
