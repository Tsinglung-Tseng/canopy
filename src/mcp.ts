// mcp — query-only stdio MCP server（mcp.md）。
// 对 molly.pageindex mcp_server.py 事故的直接架构回应：只查询、不监听、不落盘日志。
// N 个 session 起 N 个实例无共享状态冲突。工具面对齐旧 pageindex MCP，迁移即指针切换。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { run } from "./llm/kernel.js";
import type { CorpusConfig } from "./types/canopy.types.js";
import { findDocs } from "./retrieval/docs.js";
import { searchAgent } from "./search.js";
import { grepCorpus } from "./grep.js";
import { indexFile } from "./indexing.js";
import { makeLlm } from "./llm/provider.js";
import { getLogger, redirectConsoleToStderr } from "./logging.js";

const log = getLogger("mcp");

export async function startMcpServer(corpus: CorpusConfig): Promise<void> {
  // stdout 纯净纪律：第三方库 console.log 一律重定向 stderr（入口处 guard）
  redirectConsoleToStderr();
  // 启动校验 fail-loud：corpus 已由 resolveCorpus 解析（含 LLM 凭据非空），
  // 这里再触发一次 Llm 构造（401 被吞成 no relevant nodes 的旧教训——缺凭据立即崩）
  const llm = makeLlm(corpus);

  const server = new McpServer({ name: "canopy", version: "0.1.0" });

  server.registerTool(
    "find_notes",
    {
      description: "BM25 stage-1 检索，返回笔记名列表（无 LLM，快）",
      inputSchema: {
        query: z.string(),
        top_k: z.number().int().positive().default(5),
      },
    },
    ({ query, top_k }) => {
      const hits = findDocs(corpus.resultsDir, query, top_k);
      return {
        content: [
          {
            type: "text" as const,
            text: hits.length ? hits.map((h) => h.noteName).join("\n") : "No documents matched the query.",
          },
        ],
      };
    },
  );

  server.registerTool(
    "search_notes",
    {
      description: "两阶段检索（BM25 → LLM tree search）+ 答案合成",
      inputSchema: {
        query: z.string(),
        top_k: z.number().int().positive().default(5),
        lang: z.enum(["en", "zh"]).default("en"),
      },
    },
    async ({ query, top_k, lang }) => {
      const { outcome, spent } = await run(
        searchAgent(corpus.resultsDir, query, {
          topK: top_k,
          concurrency: corpus.concurrency,
          answer: true,
          lang,
        }),
        llm,
      );
      log.info(`search_notes "${query}": ${spent.calls} llm calls, out ${spent.outputTokens} tokens`);
      if (!outcome.ok) throw new Error(outcome.reason); // fail loud，不吞成 no relevant nodes
      const { results, answer } = outcome.value;
      if (!results.length) return { content: [{ type: "text" as const, text: "No documents matched the query." }] };
      return { content: [{ type: "text" as const, text: answer ?? "" }] };
    },
  );

  server.registerTool(
    "grep_notes",
    {
      description: "正则直扫源笔记，返回命中行（按笔记分组）",
      inputSchema: {
        pattern: z.string(),
        case_sensitive: z.boolean().default(false),
        max_notes: z.number().int().positive().default(20),
        max_lines_per_note: z.number().int().positive().default(5),
      },
    },
    ({ pattern, case_sensitive, max_notes, max_lines_per_note }) => {
      let matches;
      try {
        matches = grepCorpus(corpus, pattern, {
          caseSensitive: case_sensitive,
          maxNotes: max_notes,
          maxLinesPerNote: max_lines_per_note,
        });
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Invalid regex pattern: ${String(e)}` }] };
      }
      if (!matches.length) return { content: [{ type: "text" as const, text: "No matches." }] };
      const byFile = new Map<string, string[]>();
      for (const m of matches) {
        const arr = byFile.get(m.file) ?? [];
        arr.push(`  L${m.line_num}: ${m.line}`);
        byFile.set(m.file, arr);
      }
      const text = [...byFile.entries()].map(([f, lines]) => `${f}\n${lines.join("\n")}`).join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.registerTool(
    "index_note",
    {
      description:
        "手动单文件索引（query-only 原则的唯一例外：同步单次、用户显式触发，写产物）",
      inputSchema: {
        md_path: z.string(),
        force: z.boolean().default(false),
      },
    },
    async ({ md_path, force }) => {
      const report = await indexFile(corpus, llm, md_path, { force });
      return {
        content: [{ type: "text" as const, text: `${report.outcome}: ${report.result_path}` }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`canopy mcp started: corpus '${corpus.name}' (query-only, no watcher, stderr logs)`);
  // stdio transport 跟随 stdin 关闭退出；保持进程存活
  await new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });
}
