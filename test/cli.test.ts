// CLI 契约测试（ADR-004 硬约束）：stdout 纯净（--json 模式 stdout 只有一个 JSON 文档）、
// 退出码 0=成功（含零命中）/ 2=用法配置错误、日志只进 stderr。
// 通过 spawn 真实进程验证——这是跨语言消费方（readers/library-search）依赖的边界。
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const tsxCli = join(repo, "node_modules/tsx/dist/cli.mjs");

let configPath: string;
let root: string;

function canopy(args: string[], env: Record<string, string> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync(process.execPath, [tsxCli, join(repo, "src/cli.ts"), ...args], {
    encoding: "utf-8",
    env: { ...process.env, CANOPY_CONFIG: configPath, ...env },
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "canopy-cli-"));
  const vault = join(root, "vault");
  const results = join(root, "results");
  mkdirSync(vault);
  mkdirSync(results);
  writeFileSync(join(vault, "rust-notes.md"), "# Rust ownership\nborrow checker lifetimes\n");
  writeFileSync(join(vault, "cooking.md"), "# Pasta\nboil water al dente\n");
  // 用真实 golden 产物喂 find（与 molly.pageindex 混读验证的一部分）
  const goldenDir = join(here, "fixtures/golden");
  for (const f of readdirSync(goldenDir).slice(0, 5)) {
    copyFileSync(join(goldenDir, f), join(results, f));
  }
  configPath = join(root, "corpora.yaml");
  writeFileSync(
    configPath,
    `corpora:
  - name: testcorpus
    source:
      dir: ${vault}
      glob: "**/*.md"
      ignore: []
    resultsDir: ${results}
    backend: memory
    llm:
      baseURL: https://unused.example.com/v1
      apiKey: test-key-not-used
      model: test-model
    summaryTokenThreshold: 200
    concurrency: 5
`,
  );
});

describe("canopy CLI 契约", () => {
  it("corpora --json：stdout 单 JSON 文档，exit 0", () => {
    const r = canopy(["corpora", "--json"]);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout) as { corpora: Array<{ name: string; doc_count: number }> };
    expect(doc.corpora[0]?.name).toBe("testcorpus");
    expect(doc.corpora[0]?.doc_count).toBe(5);
  });

  it("find --json：真实产物命中，stdout 纯 JSON", () => {
    const r = canopy(["find", "--corpus", "testcorpus", "claude code", "--top-k", "3", "--json"]);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout) as { query: string; results: Array<{ bm25_score: number }> };
    expect(doc.query).toBe("claude code");
    expect(doc.results.length).toBeGreaterThan(0);
    expect(doc.results[0]?.bm25_score).toBeGreaterThan(0);
  });

  it("find 零命中：exit 0 + 空 results（零命中不是错误）", () => {
    const r = canopy(["find", "--corpus", "testcorpus", "xyzzy未知词汇qqq", "--json"]);
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as { results: unknown[] }).results).toEqual([]);
  });

  it("缺 corpus：exit 2 + stderr 列出可用名", () => {
    const r = canopy(["find", "--corpus", "ghost", "q"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("可用: testcorpus");
    expect(r.stdout).toBe(""); // stdout 纯净
  });

  it("配置文件不存在：exit 2", () => {
    const r = canopy(["corpora"], { CANOPY_CONFIG: "/nonexistent/corpora.yaml" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("配置错误");
  });

  it("grep --json：命中行 + 行号", () => {
    const r = canopy(["grep", "--corpus", "testcorpus", "borrow", "--json"]);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout) as { matches: Array<{ file: string; line_num: number }> };
    expect(doc.matches.length).toBe(1);
    expect(doc.matches[0]?.file).toBe("rust-notes.md");
    expect(doc.matches[0]?.line_num).toBe(2);
  });

  it("非法 --top-k：exit 2", () => {
    const r = canopy(["find", "--corpus", "testcorpus", "q", "--top-k", "abc"]);
    expect(r.status).toBe(2);
  });
});
