#!/usr/bin/env node
// cli — 唯一用户入口与跨语言消费契约（ADR-004）。
// 硬约束：stdout 纯净（--json 模式只有一个 JSON 文档；默认模式只有人类可读结果；
// 日志/进度/Cost 摘要一律 stderr）。退出码：0=成功（含零命中）；1=运行错误；2=用法/配置错误。
import { Command } from "commander";
import { existsSync, readdirSync } from "node:fs";
import { run, Budget, BudgetExhausted } from "./llm/kernel.js";
import { configureLogging, type LogLevel } from "./logging.js";
import { ConfigError, loadCorpora, resolveCorpus } from "./corpus.js";
import { findDocs } from "./retrieval/docs.js";
import { searchAgent } from "./search.js";
import { grepCorpus } from "./grep.js";
import { indexBatch, indexFile } from "./indexing.js";
import { makeLlm } from "./llm/provider.js";
import { startWatch } from "./watch.js";
import { startMcpServer } from "./mcp.js";
import type {
  CorporaResponse,
  FindResponse,
  GrepResponse,
  SearchResponse,
} from "./types/canopy.types.js";

const program = new Command();
program
  .name("canopy")
  .description("树状文档索引 + 两阶段检索（BM25 → LLM tree search）")
  .option("--log-file <path>", "落盘日志（强制 10MB×3 轮转，ADR-002）")
  .option("--log-level <level>", "debug|info|warn|error", "info")
  .hook("preAction", (cmd) => {
    const opts = cmd.opts<{ logFile?: string; logLevel: string }>();
    const level = opts.logLevel as LogLevel;
    if (!["debug", "info", "warn", "error"].includes(level)) {
      throw new ConfigError(`--log-level 必须是 debug|info|warn|error（得到 '${opts.logLevel}'）`);
    }
    configureLogging(opts.logFile ? { level, logFile: opts.logFile } : { level });
  });

/** 统一错误→退出码映射。main 之外不许 process.exit。 */
function die(e: unknown): never {
  if (e instanceof ConfigError) {
    process.stderr.write(`配置错误: ${e.message}\n`);
    process.exit(2);
  }
  if (e instanceof BudgetExhausted) {
    process.stderr.write(`Budget 见底: ${e.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`错误: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
}

function emitJson(doc: unknown): void {
  process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
}

// ── index / batch ────────────────────────────────────────────────────────────

program
  .command("index")
  .description("单文件或整 corpus 增量索引")
  .requiredOption("--corpus <name>")
  .option("--file <path>", "只索引该文件")
  .option("--force", "忽略 md5 增量，强制重建", false)
  .option("--json", "stdout 输出单个 JSON 文档", false)
  .action(async (opts: { corpus: string; file?: string; force: boolean; json: boolean }) => {
    try {
      const corpus = resolveCorpus(opts.corpus);
      const llm = makeLlm(corpus);
      if (opts.file) {
        const report = await indexFile(corpus, llm, opts.file, { force: opts.force });
        if (opts.json) emitJson(report);
        else process.stdout.write(`${report.outcome}: ${report.result_path}\n`);
      } else {
        const report = await indexBatch(corpus, llm, { force: opts.force });
        if (opts.json) emitJson(report);
        else {
          process.stdout.write(
            `indexed ${report.indexed}, skipped ${report.skipped}, failed ${report.failed}, orphans removed ${report.orphans_removed.length}\n`,
          );
          for (const f of report.failures) process.stderr.write(`  失败 ${f.file}: ${f.error}\n`);
        }
        if (report.failed > 0) process.exit(1); // 跑完再 fail（fail loud at end）
      }
    } catch (e) {
      die(e);
    }
  });

program
  .command("batch")
  .description("= index 全量增量（launchd 用）")
  .requiredOption("--corpus <name>")
  .option("--force", "忽略 md5 增量，强制重建", false)
  .option("--json", "stdout 输出单个 JSON 文档", false)
  .action(async (opts: { corpus: string; force: boolean; json: boolean }) => {
    try {
      const corpus = resolveCorpus(opts.corpus);
      const report = await indexBatch(corpus, makeLlm(corpus), { force: opts.force });
      if (opts.json) emitJson(report);
      else
        process.stdout.write(
          `indexed ${report.indexed}, skipped ${report.skipped}, failed ${report.failed}, orphans removed ${report.orphans_removed.length}\n`,
        );
      if (report.failed > 0) process.exit(1);
    } catch (e) {
      die(e);
    }
  });

// ── find（stage-1 only，无 LLM）─────────────────────────────────────────────

program
  .command("find")
  .description("BM25 stage-1 检索（无 LLM）")
  .requiredOption("--corpus <name>")
  .argument("<query>")
  .option("--top-k <n>", "候选数", "5")
  .option("--json", "stdout 输出单个 JSON 文档", false)
  .action((query: string, opts: { corpus: string; topK: string; json: boolean }) => {
    try {
      const corpus = resolveCorpus(opts.corpus);
      const hits = findDocs(corpus.resultsDir, query, parseIntStrict(opts.topK, "--top-k"));
      const doc: FindResponse = {
        query,
        corpus: corpus.name,
        results: hits.map((h) => ({
          note_name: h.noteName,
          filename: h.filename,
          bm25_score: h.score,
        })),
      };
      if (opts.json) emitJson(doc);
      else for (const r of doc.results) process.stdout.write(`${r.bm25_score.toFixed(4)}  ${r.note_name}\n`);
    } catch (e) {
      die(e);
    }
  });

// ── search（两阶段）──────────────────────────────────────────────────────────

program
  .command("search")
  .description("两阶段检索：BM25 → LLM 节点选择 → 答案合成")
  .requiredOption("--corpus <name>")
  .argument("<query>")
  .option("--top-k <n>", "stage-1 候选数", "5")
  .option("--json", "stdout 输出单个 JSON 文档（结构化模式，默认跳过答案合成）", false)
  .option("--no-answer", "跳过答案合成")
  .option("--answer", "强制答案合成（--json 下也合成）")
  .option("--lang <lang>", "答案语言 en|zh", "en")
  .option("--budget <tokens>", "本次运行 output-token 上限（缺省不设限）")
  .action(
    async (
      query: string,
      opts: {
        corpus: string;
        topK: string;
        json: boolean;
        answer?: boolean;
        lang: string;
        budget?: string;
      },
    ) => {
      try {
        if (opts.lang !== "en" && opts.lang !== "zh") {
          throw new ConfigError(`--lang 必须是 en|zh（得到 '${opts.lang}'）`);
        }
        const corpus = resolveCorpus(opts.corpus);
        const llm = makeLlm(corpus);
        // 默认：人类模式合成答案；--json 结构化模式跳过（除非显式 --answer）
        const wantAnswer = opts.answer ?? !opts.json;
        const budget = opts.budget ? parseIntStrict(opts.budget, "--budget") : null;
        const { outcome, spent } = await run(
          searchAgent(corpus.resultsDir, query, {
            topK: parseIntStrict(opts.topK, "--top-k"),
            concurrency: corpus.concurrency,
            answer: wantAnswer,
            lang: opts.lang,
          }),
          llm,
          { budget },
        );
        process.stderr.write(
          `cost: ${spent.calls} llm calls, in ${spent.inputTokens} / out ${spent.outputTokens} tokens\n`,
        );
        if (!outcome.ok) throw new Error(outcome.reason);
        const doc: SearchResponse = { query, corpus: corpus.name, results: outcome.value.results };
        if (outcome.value.answer !== undefined) doc.answer = outcome.value.answer;
        if (opts.json) emitJson(doc);
        else {
          for (const r of doc.results) {
            process.stdout.write(`${r.bm25_score.toFixed(4)}  ${r.note_name}\n`);
            for (const h of r.hits) process.stdout.write(`    [${h.node_id}] ${h.title}\n`);
          }
          if (doc.answer) process.stdout.write(`\n${doc.answer}\n`);
        }
      } catch (e) {
        die(e);
      }
    },
  );

// ── grep ─────────────────────────────────────────────────────────────────────

program
  .command("grep")
  .description("正则直扫源文件")
  .requiredOption("--corpus <name>")
  .argument("<pattern>")
  .option("--case-sensitive", "区分大小写", false)
  .option("--max-notes <n>", "命中文件数上限", "20")
  .option("--max-lines-per-note <n>", "每文件命中行上限", "5")
  .option("--json", "stdout 输出单个 JSON 文档", false)
  .action(
    (
      pattern: string,
      opts: {
        corpus: string;
        caseSensitive: boolean;
        maxNotes: string;
        maxLinesPerNote: string;
        json: boolean;
      },
    ) => {
      try {
        const corpus = resolveCorpus(opts.corpus);
        let matches;
        try {
          matches = grepCorpus(corpus, pattern, {
            caseSensitive: opts.caseSensitive,
            maxNotes: parseIntStrict(opts.maxNotes, "--max-notes"),
            maxLinesPerNote: parseIntStrict(opts.maxLinesPerNote, "--max-lines-per-note"),
          });
        } catch (e) {
          if (e instanceof SyntaxError) throw new ConfigError(`非法正则: ${e.message}`);
          throw e;
        }
        const doc: GrepResponse = { pattern, corpus: corpus.name, matches };
        if (opts.json) emitJson(doc);
        else for (const m of matches) process.stdout.write(`${m.file}:${m.line_num}: ${m.line}\n`);
      } catch (e) {
        die(e);
      }
    },
  );

// ── corpora ──────────────────────────────────────────────────────────────────

program
  .command("corpora")
  .description("列出已注册 corpus + 健康度")
  .option("--json", "stdout 输出单个 JSON 文档", false)
  .action((opts: { json: boolean }) => {
    try {
      const all = loadCorpora();
      const doc: CorporaResponse = {
        corpora: [...all.values()].map((c) => ({
          name: c.name,
          source_dir: c.source.dir,
          results_dir: c.resultsDir,
          backend: c.backend,
          doc_count: existsSync(c.resultsDir)
            ? readdirSync(c.resultsDir).filter((f) => f.endsWith("_structure.json")).length
            : 0,
        })),
      };
      if (opts.json) emitJson(doc);
      else
        for (const c of doc.corpora) {
          process.stdout.write(
            `${c.name}\t${c.backend}\t${c.doc_count} docs\t${c.source_dir} -> ${c.results_dir}\n`,
          );
        }
    } catch (e) {
      die(e);
    }
  });

// ── watch / mcp（M6）─────────────────────────────────────────────────────────

program
  .command("watch")
  .description("常驻 watcher（全局每 corpus 单实例，由进程管理者持有）")
  .requiredOption("--corpus <name>")
  .action(async (opts: { corpus: string }) => {
    try {
      const corpus = resolveCorpus(opts.corpus);
      await startWatch(corpus, makeLlm(corpus));
    } catch (e) {
      die(e);
    }
  });

program
  .command("mcp")
  .description("query-only stdio MCP server（无 watcher 无文件日志）")
  .requiredOption("--corpus <name>")
  .action(async (opts: { corpus: string }) => {
    try {
      const corpus = resolveCorpus(opts.corpus); // 启动即校验：缺配置/凭据立即非 0 退出
      await startMcpServer(corpus);
    } catch (e) {
      die(e);
    }
  });

function parseIntStrict(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${flag} 必须是正整数（得到 '${v}'）`);
  return n;
}

program.parseAsync(process.argv).catch(die);
