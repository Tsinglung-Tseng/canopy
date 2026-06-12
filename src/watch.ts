// watch — 常驻 watcher：监听 corpus 源目录，变更防抖后增量索引。
// 语义对齐旧 IndexPipeline，实现简化（watch.md）：
//   chokidar(过滤在最前) → per-path debounce → last-write-wins 版本队列 → md5 不变跳过 → indexFile
// 两个历史事故的双保险：点目录在 ignored 层挡掉（worktree 风暴 ×35828）；
// 热循环保险丝（同文件 60s 内 >10 次 → 熔断 10 分钟，旧实现缺这层，8668 次刷日志的放大器）。
import { watch as chokidarWatch } from "chokidar";
import { basename } from "node:path";
import type { Llm } from "./llm/kernel.js";
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
  /** 同路径任务串行链：iCloud 在本地落盘后数秒会再触发一次同步事件，若与上一次
   *  索引（LLM 数秒）并行，md5 记录尚未落盘 → 跳过判定扑空 → 同文件双倍全量重索引
   *  （实测 2026-06-12：单次原子写入产物被重写两遍）。串行后第二个事件在第一个
   *  完成后再跑：md5 已记录、内容未变 → 零成本跳过。 */
  chain: Promise<void>;
}

export async function startWatch(corpus: CorpusConfig, llm: Llm): Promise<void> {
  const debounceMs = (corpus.debounceSec ?? DEFAULT_DEBOUNCE_SEC) * 1000;
  const states = new Map<string, PathState>();

  const watcher = chokidarWatch(corpus.source.dir, {
    ignored: (path: string) => basename(path).startsWith("."), // 点目录/点文件最前置过滤
    ignoreInitial: true,
    // 不跟符号链接（对齐 Python watchdog 行为）：vault 内的 symlink 可能指向整个
    // 代码仓（node_modules 数万目录 → EMFILE）甚至构成环（链接回本仓 results/）。
    // 实测 2026-06-12：RPG vault Projects/ 下 164 个链接，不关此项 watch 起即爆。
    followSymlinks: false,
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
      state = { version: 0, events: [], fusedUntil: 0, chain: Promise.resolve() };
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
      const st = state as PathState;
      st.chain = st.chain.then(() => handle(path, st, version));
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
