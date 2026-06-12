// indexing — 单文件索引完整生命周期：源 .md → core 建树 → llm 摘要 → 规范名 JSON 落盘。
// 关键语义（ADR-006 / indexing.md）：
//   · 规范名：相对 corpus 根，'/'→'__'、' '→'_'、去扩展名 + '_structure.json'，
//     直接写最终路径（旧实现"先裸名再改名"的坑直接消灭）。
//   · 增量：源文件 md5 vs 状态侧车（<resultsDir>/.canopy-state.json）；既有产物
//     （含 structure 键）首扫无 md5 记录时收养（记 md5 即跳过）——47MB 资产零重建。
//   · 原子写：先 .tmp 再 rename，防查询端读到半个 JSON。
//   · 兼容序列化：JSON.stringify(x, null, 2) 与 Python json.dumps(indent=2,
//     ensure_ascii=False) 实测逐字节一致（2026-06-11 roundtrip 验证）。
import { createHash } from "node:crypto";
import {
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { run } from "./llm/kernel.js";
import type { Llm } from "./llm/kernel.js";
import type { BatchReport, CorpusConfig, DocStructure, IndexReport } from "./types/canopy.types.js";
import { mdToTree } from "./core/tree.js";
import { buildSummaries, buildSummaryCache } from "./llm/agents.js";
import type { SummaryCache } from "./llm/agents.js";
import { getLogger } from "./logging.js";

const log = getLogger("indexing");

const DEFAULT_TIMEOUT_SEC = 300; // 文档化可选字段缺省（indexing.md 旧值）

/** 规范产物路径（get_result_path 修复后语义：完整相对路径，非裸 basename）。 */
/** 词法绝对路径 → 目录符号链接展开后的绝对路径（文件本身可不存在——父目录 realpath
 *  + basename）。对齐 Python Path.resolve() 语义：corpus.dir 解析时已 realpath，
 *  否则 ~/obsidian/X 这类 symlink 入口与 iCloud 真实路径会互判"不在 corpus 内"。 */
function realAbs(p: string): string {
  const abs = resolve(p);
  return join(realpathSync(dirname(abs)), basename(abs));
}

export function getResultPath(corpus: CorpusConfig, mdPath: string): string {
  // 词法路径优先：vault 设计上用符号链接把外部项目的 md 挂进来（Python 版
  // os.walk(followlinks=True) 同语义），这些文件的身份是 vault 内词法路径，
  // realpath 会把它们解析出 corpus。词法越界时才用 realAbs 兜底——处理调用方
  // 以 symlink 入口（~/obsidian/X）与真实路径两种写法指 corpus 根的情况。
  const lexical = resolve(mdPath);
  let rel = relative(corpus.source.dir, lexical);
  if (rel.startsWith("..")) {
    rel = relative(corpus.source.dir, realAbs(lexical));
  }
  if (rel.startsWith("..")) {
    throw new Error(`文件不在 corpus '${corpus.name}' 源目录内: ${lexical}`);
  }
  const safe = rel.split(sep).join("__").replaceAll(" ", "_");
  return join(corpus.resultsDir, safe.replace(/\.[^./]*$/, "") + "_structure.json");
}

export function md5OfFile(path: string): string {
  return createHash("md5").update(readFileSync(path)).digest("hex");
}

/** 增量判定用内容指纹：剔除 frontmatter 中配置声明的易变键（含其缩进延续行）后
 *  取 md5。易变键（updatetime 类自动戳、writeback 回写的 auto_summary*）的变更
 *  不应触发整篇重索引——节点摘要全量重生成是真金白银，且 writeback→watch 会自激
 *  （实测 2026-06-12：600+ 文件仅 updatetime 变更被整批重索引+重回写）。
 *  仅影响增量判定；树内容仍取完整原文（产物文本不受归一化影响）。 */
export function md5ForIncrement(path: string, volatileKeys?: string[]): string {
  const raw = readFileSync(path, "utf-8");
  if (!volatileKeys || volatileKeys.length === 0) {
    return createHash("md5").update(raw).digest("hex");
  }
  return createHash("md5").update(stripVolatileFrontmatter(raw, volatileKeys)).digest("hex");
}

/** 仅处理文件头部 frontmatter 块（--- ... ---）；块内匹配键的行与其后续缩进
 *  延续行一并剔除。非 frontmatter 内容逐字保留。 */
export function stripVolatileFrontmatter(content: string, keys: string[]): string {
  if (!content.startsWith("---\n")) return content;
  const lines = content.split("\n");
  const end = lines.indexOf("---", 1);
  if (end < 0) return content;
  const keySet = new Set(keys);
  const kept: string[] = [lines[0] as string];
  let skipping = false;
  for (let i = 1; i < end; i++) {
    const line = lines[i] as string;
    const m = /^([A-Za-z0-9_-]+):/.exec(line);
    if (m) skipping = keySet.has(m[1] as string);
    else if (!/^[\s]/.test(line) && line !== "") skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.concat(lines.slice(end)).join("\n");
}

function isAlreadyIndexed(resultPath: string): boolean {
  if (!existsSync(resultPath)) return false;
  try {
    const data: unknown = JSON.parse(readFileSync(resultPath, "utf-8"));
    return !!data && typeof data === "object" && "structure" in (data as object);
  } catch {
    return false; // 半个 JSON / 损坏产物 = 未索引（兼容层宽容读）
  }
}

// ── md5 状态侧车 ──────────────────────────────────────────────────────────────

interface StateFile {
  version: 1;
  md5: Record<string, string>; // 产物文件名 → 源文件 md5
}

function statePath(corpus: CorpusConfig): string {
  return join(corpus.resultsDir, ".canopy-state.json");
}

function loadState(corpus: CorpusConfig): StateFile {
  const p = statePath(corpus);
  if (!existsSync(p)) return { version: 1, md5: {} };
  // 损坏自愈（允许的 fallback：state 只是 md5 跳过缓存，不是真相源——损坏时改名
  // 留证 + warn + 从空重建，收养机制零 LLM 成本补回条目；fail loud 在这里意味着
  // 整条夜间链路停摆，代价不对称。实测 2026-06-12：并发同名 tmp 写坏 state 后
  // 全部 751 个索引调用因解析失败全军覆没）。
  let data: StateFile;
  try {
    data = JSON.parse(readFileSync(p, "utf-8")) as StateFile;
    if (data.version !== 1 || typeof data.md5 !== "object") throw new Error("schema mismatch");
  } catch (e) {
    const quarantine = `${p}.corrupt-${process.pid}`;
    renameSync(p, quarantine);
    log.warn(`状态文件损坏，已隔离到 ${quarantine}，从空重建（收养机制自愈）: ${e instanceof Error ? e.message : e}`);
    return { version: 1, md5: {} };
  }
  return data;
}

function saveState(corpus: CorpusConfig, state: StateFile): void {
  const p = statePath(corpus);
  atomicWrite(p, JSON.stringify(state, null, 2));
}

let tmpSeq = 0;

function atomicWrite(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  // tmp 名必须含 pid+序号：batch 编排器会并发 spawn 多个 canopy 进程写同一 state
  // 侧车，共享 tmp 名会互相 rename 掉对方（ENOENT）甚至交错写坏内容（实测
  // 2026-06-12 state 损坏事故）。唯一 tmp + 原子 rename = last-write-wins，丢失的
  // md5 条目由收养机制零成本自愈（产物在、无记录 → 记 md5 跳过）。
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// ── 单文件索引 ────────────────────────────────────────────────────────────────

export interface IndexFileOpts {
  force?: boolean;
}

/** 'ok' | 'skipped-unchanged' | throw（超时是真错误）。 */
export async function indexFile(
  corpus: CorpusConfig,
  llm: Llm,
  mdPath: string,
  opts: IndexFileOpts = {},
): Promise<IndexReport> {
  const abs = resolve(mdPath); // 词法路径（vault 内符号链接身份，见 getResultPath）
  const resultPath = getResultPath(corpus, abs);
  const resultName = basename(resultPath);
  const currentMd5 = md5ForIncrement(abs, corpus.volatileFrontmatterKeys);
  const state = loadState(corpus);

  // M8.5：重索引（md5 不匹配）时从既有产物建节点级摘要复用缓存——未变更节点的
  // 摘要不重烧 LLM。force 显式跳过复用（prompt/阈值/模型变更时强制全量重生成）。
  let cache: SummaryCache | undefined;
  const alreadyIndexed = isAlreadyIndexed(resultPath);
  if (!opts.force && alreadyIndexed) {
    const recorded = state.md5[resultName];
    if (recorded === currentMd5) {
      return { file: abs, outcome: "skipped-unchanged", result_path: resultPath };
    }
    if (recorded === undefined) {
      // 收养既有产物（molly.pageindex 47MB 资产）：记 md5，不烧 LLM 重建（ADR-006 迁移期零重建）
      state.md5[resultName] = currentMd5;
      saveState(corpus, state);
      return { file: abs, outcome: "skipped-unchanged", result_path: resultPath };
    }
    cache = loadSummaryCache(resultPath);
  }

  const content = readFileSync(abs, "utf-8");
  const docName = basename(abs).replace(/\.[^./]*$/, "");
  const doc = mdToTree(content, { docName, withText: true });

  const timeoutSec = corpus.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const summarized = await withTimeout(
    runSummaries(doc, llm, corpus.summaryTokenThreshold, cache),
    timeoutSec,
    `索引超时（${timeoutSec}s）: ${abs}`,
  );

  atomicWrite(resultPath, JSON.stringify(summarized, null, 2));
  state.md5[resultName] = currentMd5;
  saveState(corpus, state);
  log.info(`indexed: ${relative(corpus.source.dir, abs)} -> ${resultName}`);
  return { file: abs, outcome: "ok", result_path: resultPath };
}

/** 既有产物 → 节点级摘要复用缓存（M8.5）。损坏产物 → 无缓存（兼容层宽容读，
 *  退化为全量重生成，安全）。 */
function loadSummaryCache(resultPath: string): SummaryCache | undefined {
  try {
    const prior = JSON.parse(readFileSync(resultPath, "utf-8")) as DocStructure;
    return buildSummaryCache(prior);
  } catch {
    return undefined;
  }
}

async function runSummaries(
  doc: DocStructure,
  llm: Llm,
  threshold: number,
  cache?: SummaryCache,
): Promise<DocStructure> {
  const { outcome, spent } = await run(buildSummaries(doc, threshold, cache), llm);
  if (!outcome.ok) throw new Error(`摘要生成失败: ${outcome.reason}`);
  log.info(`summaries done: ${doc.doc_name} (${spent.calls} llm calls, ${spent.outputTokens} out-tokens)`);
  return outcome.value;
}

function withTimeout<T>(p: Promise<T>, sec: number, msg: string): Promise<T> {
  return new Promise<T>((resolveP, rejectP) => {
    const t = setTimeout(() => rejectP(new Error(msg)), sec * 1000);
    p.then(
      (v) => {
        clearTimeout(t);
        resolveP(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        rejectP(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

// ── 批量 ─────────────────────────────────────────────────────────────────────

/** corpus 源文件枚举：config glob + ignore；点目录无条件不进（ADR-002 规则 3 的索引面）。 */
export function listSourceFiles(corpus: CorpusConfig): string[] {
  const files = globSync(corpus.source.glob, {
    cwd: corpus.source.dir,
    exclude: corpus.source.ignore,
  });
  return files
    .filter((rel) => !rel.split("/").some((part) => part.startsWith(".")))
    .sort()
    .map((rel) => join(corpus.source.dir, rel));
}

/** 全量增量。失败按文件计入 failed 继续跑完再报（fail loud at end, not fail half）。 */
export async function indexBatch(
  corpus: CorpusConfig,
  llm: Llm,
  opts: IndexFileOpts = {},
): Promise<BatchReport> {
  const files = listSourceFiles(corpus);
  let indexed = 0;
  let skipped = 0;
  const failures: Array<{ file: string; error: string }> = [];
  for (const f of files) {
    try {
      const r = await indexFile(corpus, llm, f, opts);
      if (r.outcome === "ok") indexed++;
      else skipped++;
    } catch (e) {
      failures.push({ file: f, error: e instanceof Error ? e.message : String(e) });
      log.warn(`index failed: ${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const orphansRemoved = cleanupOrphans(corpus);
  return {
    corpus: corpus.name,
    indexed,
    skipped,
    failed: failures.length,
    failures,
    orphans_removed: orphansRemoved,
  };
}

/** 源已删的产物清理（含状态侧车条目）。返回被删产物文件名列表。 */
export function cleanupOrphans(corpus: CorpusConfig): string[] {
  const valid = new Set(listSourceFiles(corpus).map((f) => basename(getResultPath(corpus, f))));
  const removed: string[] = [];
  const state = loadState(corpus);
  for (const name of globSync("*_structure.json", { cwd: corpus.resultsDir })) {
    if (!valid.has(name)) {
      unlinkSync(join(corpus.resultsDir, name));
      delete state.md5[name];
      removed.push(name);
      log.info(`cleanup: removed orphan ${name}`);
    }
  }
  if (removed.length) saveState(corpus, state);
  return removed;
}
