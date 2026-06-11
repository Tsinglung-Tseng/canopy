# watch — 常驻 watcher

状态：设计完成（未开始编码）

## 职责

`canopy watch --corpus <name>`：监听 corpus 源目录，变更防抖后增量索引。**全局每 corpus 只跑一份**，由进程管理者持有（vault corpus = Molly worker；将来服务器场景 = launchd/systemd）。

## 架构（语义对齐旧 IndexPipeline，实现简化）

```
chokidar.watch(source.dir, { ignored: 点目录 + ignore globs, awaitWriteFinish: true })
  → debounce(per-path, corpus.debounceSec)
  → last-write-wins 队列（版本号；过期任务直接丢）
  → md5 不变跳过
  → indexFile()
```

## 关键实现

- **过滤在最前**：`.claude/`、`.obsidian/` 等点目录在 chokidar ignored 层挡掉，不进队列不进日志——worktree traceback 风暴（35828 条）和热循环（同文件 8668 次 change）两个事故的双保险。
- 瞬态错误（文件已删、EBUSY）单行 warn 无 stack（ADR-002 规则 3）。
- 热循环保险丝：同一路径在滚动窗口内触发超阈值（如 60s 内 >10 次）→ 该路径熔断 10 分钟并 warn 一次。旧实现没有这层，是 8668 次刷日志的放大器。
- 退出语义：进程管理者负责生命周期（Molly 已有 SIGTERM→SIGKILL 树清理；无需自带 parent-death kqueue 黑科技——那是 stdio MCP 跟随 session 退出的需求，watch 不需要）。

## 与 Molly 集成

Molly config.json 的 pageindex watcher 条目改为：
`startCmd: "canopy watch --corpus vault"`（stdout/stderr 进 Molly 内存日志面板，500 行环形缓冲，天然无失控面）。

## 依赖

chokidar、indexing、corpus、logging。
