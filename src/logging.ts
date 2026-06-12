// logging — 日志三铁律（ADR-002）唯一配置点。
// 1. 库代码不落盘：库层只 getLogger，永不配 sink。
// 2. 默认 stderr；--log-file 显式 opt-in 才写文件，且强制 10MB×3 轮转，无直写选项。
// 3. 降噪内建：第三方钳到 warn；已知瞬态错误单行 warn 无 stack。
// 实现选型：手写 size-check-and-rotate sink（~50 行）——pino+pino-roll 依赖面更大，
// 接口不变，需要时可换（logging.md 文档化的开口）。
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const ROTATE_BYTES = 10 * 1024 * 1024; // 10 MB
const ROTATE_KEEP = 3;

interface Sink {
  write(line: string): void;
}

const stderrSink: Sink = {
  write(line) {
    process.stderr.write(line + "\n");
  },
};

/** 落盘必轮转：size-based rotation（10MB × 3 份），不存在无轮转落盘的代码路径。 */
class RotatingFileSink implements Sink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }
  write(line: string): void {
    try {
      if (existsSync(this.path) && statSync(this.path).size >= ROTATE_BYTES) {
        for (let i = ROTATE_KEEP - 1; i >= 1; i--) {
          const src = i === 1 ? this.path : `${this.path}.${i - 1}`;
          if (existsSync(src)) renameSync(src, `${this.path}.${i}`);
        }
      }
      appendFileSync(this.path, line + "\n");
    } catch {
      process.stderr.write(line + "\n"); // 日志写盘失败不让业务崩，降级 stderr
    }
  }
}

let globalLevel: LogLevel = "info";
let globalSink: Sink = stderrSink;
let configured = false;

export interface LoggingOpts {
  level?: LogLevel;
  logFile?: string;
}

/** 仅入口（cli.ts）调用一次。库代码一律 getLogger。 */
export function configureLogging(opts: LoggingOpts): void {
  if (configured) throw new Error("configureLogging 只许入口调用一次（ADR-002 铁律 1）");
  configured = true;
  if (opts.level) globalLevel = opts.level;
  if (opts.logFile) globalSink = new RotatingFileSink(opts.logFile);
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

export function getLogger(name: string): Logger {
  const emit = (level: LogLevel, msg: string) => {
    if (LEVEL_RANK[level] < LEVEL_RANK[globalLevel]) return;
    globalSink.write(`${new Date().toISOString()} [${level}] ${name}: ${msg}`);
  };
  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    // error 级带 stack 仅限"未知异常"（铁律 3 的 code-review 检查点）
    error: (m, err?) =>
      emit("error", err instanceof Error ? `${m}: ${err.stack ?? err.message}` : m),
  };
}

/** 已枚举瞬态错误（ENOENT / worktree 消失 / EBUSY 类）：单行 warn，无 stack。 */
export function transientWarn(log: Logger, msg: string): void {
  log.warn(msg);
}

/** 第三方输出钳制：console.log/info/debug 重定向到 stderr（MCP stdio 纯净纪律）。
 *  MCP 入口必须先调它——stdout 永远不属于日志（ADR-004）。 */
export function redirectConsoleToStderr(): void {
  const toStderr =
    (tag: string) =>
    (...args: unknown[]) =>
      process.stderr.write(`[console.${tag}] ${args.map(String).join(" ")}\n`);
  console.log = toStderr("log");
  console.info = toStderr("info");
  console.debug = toStderr("debug");
  console.warn = toStderr("warn");
  console.error = toStderr("error");
}
