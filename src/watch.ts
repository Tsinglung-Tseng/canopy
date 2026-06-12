// watch — 常驻 watcher：监听 corpus 源目录，变更防抖后增量索引。
// 语义对齐旧 IndexPipeline，实现简化（watch.md）：
//   chokidar(过滤在最前) → per-path debounce → last-write-wins 版本队列 → md5 不变跳过 → indexFile
// 两个历史事故的双保险：点目录在 ignored 层挡掉（worktree 风暴 ×35828）；
// 热循环保险丝（同文件 60s 内 >10 次 → 熔断 10 分钟，旧实现缺这层，8668 次刷日志的放大器）。
import { watch as chokidarWatch } from "chokidar";
import { basename } from "node:path";
import type { Llm } from "plexus";
import type { CorpusConfig } from "./types/canopy.types.js";
import { indexFile } from "./indexing.js";
import { getLogger, transientWarn } from "./logging.js";

const log = getLogger("watch");

const DEFAULT_DEBOUNCE_SEC = 2; // 文档化可选字段缺省（watch.md）
const FUSE_WINDOW_MS = 60_000;
const FUSE_THRESHOLD = 10;
const FUSE_COOLDOWN_MS = 10 * 60_000;

interface PathState {
  timer?: NodeJS.Timeout;
  version: number;
  events: number[]; // 滚动窗口内的触发时间戳（保险丝）
  fusedUntil: number;
}

export async function startWatch(corpus: CorpusConfig, llm: Llm): Promise<void> {
  const debounceMs = (corpus.debounceSec ?? DEFAULT_DEBOUNCE_SEC) * 1000;
  const states = new Map<string, PathState>();

  const watcher = chokidarWatch(corpus.source.dir, {
    ignored: (path: string) => basename(path).startsWith("."), // 点目录/点文件最前置过滤
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
  });

  async function handle(path: string, state: PathState, version: number): Promise<void> {
    if (version !== state.version) return; // last-write-wins：过期任务直接丢
    try {
      const report = await indexFile(corpus, llm, path);
      if (report.outcome === "ok") log.info(`reindexed: ${path}`);
      // skipped-unchanged 静默（md5 不变跳过，不进日志面）
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/ENOENT|EBUSY|不在 corpus/.test(msg)) {
        transientWarn(log, `transient: ${path}: ${msg}`); // 单行 warn 无 stack（ADR-002 规则 3）
      } else {
        log.error(`index failed: ${path}`, e);
      }
    }
  }

  function onChange(path: string): void {
    if (!path.endsWith(".md")) return;
    const now = Date.now();
    let state = states.get(path);
    if (!state) {
      state = { version: 0, events: [], fusedUntil: 0 };
      states.set(path, state);
    }
    if (now < state.fusedUntil) return; // 熔断中：不进队列不进日志
    state.events = state.events.filter((t) => now - t < FUSE_WINDOW_MS);
    state.events.push(now);
    if (state.events.length > FUSE_THRESHOLD) {
      state.fusedUntil = now + FUSE_COOLDOWN_MS;
      state.events = [];
      log.warn(`热循环熔断 10 分钟: ${path}（60s 内 >${FUSE_THRESHOLD} 次触发）`);
      return;
    }
    state.version++;
    const version = state.version;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void handle(path, state as PathState, version);
    }, debounceMs);
  }

  watcher.on("add", onChange);
  watcher.on("change", onChange);
  watcher.on("error", (e) => transientWarn(log, `watcher error: ${String(e)}`));

  log.info(
    `canopy watch started: corpus '${corpus.name}', dir ${corpus.source.dir}, debounce ${debounceMs}ms`,
  );

  // 退出语义：进程管理者负责生命周期（Molly SIGTERM→SIGKILL）；这里只优雅收尾
  await new Promise<void>((resolve) => {
    const stop = () => {
      void watcher.close().then(resolve);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });
}
