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
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { run } from "plexus";
import type { Llm } from "plexus";
import type { BatchReport, CorpusConfig, DocStructure, IndexReport } from "./types/canopy.types.js";
import { mdToTree } from "./core/tree.js";
import { buildSummaries } from "./llm/agents.js";
import { getLogger } from "./logging.js";

const log = getLogger("indexing");

const DEFAULT_TIMEOUT_SEC = 300; // 文档化可选字段缺省（indexing.md 旧值）

/** 规范产物路径（get_result_path 修复后语义：完整相对路径，非裸 basename）。 */
export function getResultPath(corpus: CorpusConfig, mdPath: string): string {
  const abs = resolve(mdPath);
  const rel = relative(corpus.source.dir, abs);
  if (rel.startsWith("..")) {
    throw new Error(`文件不在 corpus '${corpus.name}' 源目录内: ${abs}`);
  }
  const safe = rel.split(sep).join("__").replaceAll(" ", "_");
  return join(corpus.resultsDir, safe.replace(/\.[^./]*$/, "") + "_structure.json");
}

export function md5OfFile(path: string): string {
  return createHash("md5").update(readFileSync(path)).digest("hex");
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
  const data = JSON.parse(readFileSync(p, "utf-8")) as StateFile;
  if (data.version !== 1 || typeof data.md5 !== "object") {
    throw new Error(`状态文件损坏: ${p}（删除后重跑可重建）`);
  }
  return data;
}

function saveState(corpus: CorpusConfig, state: StateFile): void {
  const p = statePath(corpus);
  atomicWrite(p, JSON.stringify(state, null, 2));
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = path + ".tmp";
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
  const abs = resolve(mdPath);
  const resultPath = getResultPath(corpus, abs);
  const resultName = basename(resultPath);
  const currentMd5 = md5OfFile(abs);
  const state = loadState(corpus);

  if (!opts.force && isAlreadyIndexed(resultPath)) {
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
  }

  const content = readFileSync(abs, "utf-8");
  const docName = basename(abs).replace(/\.[^./]*$/, "");
  const doc = mdToTree(content, { docName, withText: true });

  const timeoutSec = corpus.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const summarized = await withTimeout(
    runSummaries(doc, llm, corpus.summaryTokenThreshold),
    timeoutSec,
    `索引超时（${timeoutSec}s）: ${abs}`,
  );

  atomicWrite(resultPath, JSON.stringify(summarized, null, 2));
  state.md5[resultName] = currentMd5;
  saveState(corpus, state);
  log.info(`indexed: ${relative(corpus.source.dir, abs)} -> ${resultName}`);
  return { file: abs, outcome: "ok", result_path: resultPath };
}

async function runSummaries(doc: DocStructure, llm: Llm, threshold: number): Promise<DocStructure> {
  const { outcome, spent } = await run(buildSummaries(doc, threshold), llm);
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
