# logging — 日志三铁律实现

状态：已实现（src/logging.ts，2026-06-11）

## 职责

`src/logging.ts`：全项目唯一日志配置点，实现 ADR-002 三铁律。

## 架构

```
getLogger(name): Logger           // 库代码用：拿实例，永不配 sink
configureLogging(opts): void      // 仅入口（cli.ts）调用一次：
  { level, logFile? }             //   缺 logFile → stderr
                                  //   有 logFile → 强制 RotatingFile(10MB × 3)，无直写选项
clampThirdParty(): void           // MCP SDK / http 客户端 logger → warn
transientWarn(log, msg): void     // 单行 warn 无 stack（ENOENT / worktree / EBUSY 类）
```

实现选型：pino（stderr destination 默认）+ 轮转用 `pino-roll`；若依赖审计嫌重，退而手写 ~50 行 size-check-and-rotate sink——M5 时定，接口不变。

## 强约束（code review 检查点）

1. 全仓 grep 不允许出现 `createWriteStream`/`appendFile` 写 `.log` 的旁路。
2. `configureLogging` 只在 `cli.ts` 出现一次；其余文件只许 `getLogger`。
3. stdout 永远不属于日志（ADR-004 stdout 纯净契约）。
4. error 级带 stack 仅限"未知异常"；已枚举的瞬态错误一律 `transientWarn`。

## 旧世界对照（为什么每条都存在）

| 铁律 | 对应事故 |
|---|---|
| 库不落盘 | basicConfig(FileHandler) 被 2342 个进程实例共享追加 |
| 落盘必轮转 | mcp_server.log 无上限涨到 1.4 GB |
| 降噪内建 | traceback ×35828 + 热循环 ×8668 把任何轮转窗口滚穿 |
