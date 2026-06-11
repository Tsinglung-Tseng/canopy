# ADR-002 日志三铁律

## 背景

molly.pageindex `mcp_server.log` 失控至 1.4 GB（2026-06-11 实测）。根因三连：

1. **库层自开 FileHandler**：`logging.basicConfig(FileHandler)` 写在被 import 的模块里，每个 Claude Code session 各起一个 stdio MCP 进程（日志内 2342 次启动记录），全部 O_APPEND 同一文件，且 MCP SDK 把每个请求打 INFO。
2. **瞬态错误带全栈 traceback**：`.claude/worktrees/` 临时 worktree 删除后，watcher 队列里的文件全部 FileNotFoundError，每条 `exc_info=True`（尾部 50 MB 内 35828 条）。
3. **watchdog 热循环**：单文件 change 事件风暴（50 MB 内同一文件 8668 次）。

另证：launchd 的 `StandardOutPath/StandardErrorPath` 仅是 open(O_APPEND)+dup2，无轮转无上限；macOS 系统轮转靠 newsyslog（需 root 配 /etc/newsyslog.d）。结论：**轮转责任必须内建在工具里，不能指望进程管理者**。

## 决策

三条铁律，实现于 `src/logging.ts`，全部入口强制走它：

1. **库代码不落盘**：库层只拿 logger 实例用，永不配置 sink、永不开文件。日志去向由进程入口（CLI/MCP/watch）唯一决定。
2. **默认 stderr；落盘必轮转**：所有入口默认 stderr。`--log-file <path>` 显式 opt-in 才写文件，且强制 size-based rotation（10 MB × 3 份），**不存在无轮转落盘的代码路径**。
3. **降噪内建**：第三方 logger（MCP SDK、HTTP 客户端）钳到 warn；已知瞬态错误（ENOENT、worktree 路径）单行 warn 不带 stack；忽略目录（`.claude/`、`.obsidian/` 等点目录）在 watcher 层过滤，不进日志不进索引。

## 理由

规则 1 杀死"N 进程共写一文件"的结构性根因；规则 2 让最坏情况封顶 40 MB；规则 3 防止轮转窗口被噪音滚穿（否则 10 MB 窗口几小时滚穿，等于没历史）。
