// M6 行为验证：真实进程级 e2e。
// watch：写 md → debounce → 产物落盘（增量链路全通，MockLlm 不可用故用全短节点=零 LLM 调用）。
// mcp：stdio JSON-RPC 握手 → tools/list → find_notes / grep_notes / index_note；
//      stdout 每行都必须是合法 JSON-RPC（纯净纪律的可执行断言）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const tsxCli = join(repo, "node_modules/tsx/dist/cli.mjs");

let root: string;
let vault: string;
let results: string;
let configPath: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "canopy-daemon-"));
  vault = join(root, "vault");
  results = join(root, "results");
  mkdirSync(vault);
  mkdirSync(results);
  const goldenDir = join(here, "fixtures/golden");
  // 显式点名 golden 产物，不依赖目录序（find_notes 查询 "claude code" 依赖 fixture 内容）
  for (const f of [
    "AI_编码助手对比_Claude-Code-Workflow_structure.json",
    "AI_装配线笔记_Agent-Pipeline_structure.json",
    "Database_合成示例_全文索引_structure.json",
  ]) {
    copyFileSync(join(goldenDir, f), join(results, f));
  }
  configPath = join(root, "corpora.yaml");
  writeFileSync(
    configPath,
    `corpora:
  - name: t
    source:
      dir: ${vault}
      glob: "**/*.md"
      ignore: []
    resultsDir: ${results}
    backend: memory
    llm:
      baseURL: https://unused.example.com/v1
      apiKey: not-used-all-nodes-below-threshold
      model: test-model
    summaryTokenThreshold: 200
    concurrency: 5
    debounceSec: 1
`,
  );
});

function spawnCanopy(args: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [tsxCli, join(repo, "src/cli.ts"), ...args], {
    env: { ...process.env, CANOPY_CONFIG: configPath },
  });
}

async function poll(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`poll 超时: ${what}`);
}

describe("canopy watch（进程级）", () => {
  let proc: ChildProcessWithoutNullStreams;
  afterAll(() => {
    proc?.kill("SIGTERM");
  });

  it("写 md → debounce → 产物 JSON 落盘；点目录文件不触发", async () => {
    proc = spawnCanopy(["watch", "--corpus", "t"]);
    let stderrBuf = "";
    proc.stderr.on("data", (d: Buffer) => (stderrBuf += d.toString()));
    await poll(() => stderrBuf.includes("canopy watch started"), 15_000, "watch 启动行");

    // 点目录文件：不应产生任何产物
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    writeFileSync(join(vault, ".obsidian/hidden.md"), "# Hidden\nx");
    // 正常文件（全部短节点 → 摘要直接用原文，零 LLM 调用）
    writeFileSync(join(vault, "watched note.md"), "# Watched\nshort body\n## Sub\nmore");

    const product = join(results, "watched_note_structure.json");
    await poll(() => existsSync(product), 20_000, "产物落盘");
    const doc = JSON.parse(readFileSync(product, "utf-8")) as {
      doc_name: string;
      structure: Array<{ prefix_summary?: string }>;
    };
    expect(doc.doc_name).toBe("watched note");
    expect(doc.structure[0]?.prefix_summary).toBe("# Watched\nshort body");
    expect(existsSync(join(results, "hidden_structure.json"))).toBe(false);
    expect(existsSync(join(results, ".obsidian__hidden_structure.json"))).toBe(false);
  }, 45_000);
});

describe("canopy mcp（stdio JSON-RPC）", () => {
  let proc: ChildProcessWithoutNullStreams;
  const responses = new Map<number, Record<string, unknown>>();
  let stdoutRaw = "";

  function send(msg: Record<string, unknown>): void {
    proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  async function call(id: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    await poll(() => responses.has(id), 20_000, `rpc #${id} ${method}`);
    return responses.get(id) as Record<string, unknown>;
  }

  beforeAll(async () => {
    proc = spawnCanopy(["mcp", "--corpus", "t"]);
    let buf = "";
    proc.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      stdoutRaw += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as Record<string, unknown>; // 不合法 JSON 即抛 = 纯净断言
        if (typeof msg["id"] === "number") responses.set(msg["id"], msg);
      }
    });
    const init = await call(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    });
    expect((init["result"] as Record<string, unknown>)["serverInfo"]).toMatchObject({ name: "canopy" });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }, 30_000);

  afterAll(() => {
    proc?.kill("SIGTERM");
  });

  it("tools/list：四个工具面（find/search/grep/index_note）", async () => {
    const r = await call(2, "tools/list");
    const tools = ((r["result"] as Record<string, unknown>)["tools"] as Array<{ name: string }>).map((t) => t.name);
    expect(tools.sort()).toEqual(["find_notes", "grep_notes", "index_note", "search_notes"]);
  });

  it("find_notes：真实 golden 产物命中", async () => {
    const r = await call(3, "tools/call", {
      name: "find_notes",
      arguments: { query: "claude code", top_k: 3 },
    });
    const content = (r["result"] as { content: Array<{ text: string }> }).content;
    expect(content[0]?.text.length).toBeGreaterThan(0);
    expect(content[0]?.text).not.toContain("No documents matched");
  });

  it("index_note：query-only 唯一例外（短节点零 LLM）→ 产物落盘后 find 可命中", async () => {
    const md = join(vault, "via-mcp.md");
    writeFileSync(md, "# ViaMcp uniquetokenxyzzy\nshort body");
    const r = await call(4, "tools/call", { name: "index_note", arguments: { md_path: md } });
    const text = (r["result"] as { content: Array<{ text: string }> }).content[0]?.text;
    expect(text).toContain("ok:");
    const r2 = await call(5, "tools/call", {
      name: "find_notes",
      arguments: { query: "uniquetokenxyzzy", top_k: 3 },
    });
    expect((r2["result"] as { content: Array<{ text: string }> }).content[0]?.text).toContain("via-mcp");
  });

  it("grep_notes：按笔记分组 + 行号", async () => {
    const r = await call(6, "tools/call", {
      name: "grep_notes",
      arguments: { pattern: "uniquetokenxyzzy" },
    });
    const text = (r["result"] as { content: Array<{ text: string }> }).content[0]?.text;
    expect(text).toContain("via-mcp.md");
    expect(text).toContain("L1:");
  });

  it("stdout 全程纯 JSON-RPC（无日志污染）", () => {
    for (const line of stdoutRaw.split("\n")) {
      if (line.trim()) expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
