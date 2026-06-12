// corpus 解析 fail-loud 测试：未知键、缺环境变量、缺字段、重名、找不到配置。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpora, resolveCorpus, ConfigError } from "../src/corpus.js";

let dir: string;
let srcDir: string;

function writeConfig(yaml: string): void {
  const p = join(dir, "corpora.yaml");
  writeFileSync(p, yaml);
  process.env["CANOPY_CONFIG"] = p;
}

function validYaml(extra = ""): string {
  return `corpora:
  - name: test
    source:
      dir: ${srcDir}
      glob: "**/*.md"
      ignore: [".*/**"]
    resultsDir: ${join(dir, "results")}
    backend: memory
    llm:
      baseURL: \${CANOPY_TEST_BASE_URL}
      apiKey: \${CANOPY_TEST_API_KEY}
      model: test-model
    summaryTokenThreshold: 200
    concurrency: 5
${extra}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "canopy-corpus-"));
  srcDir = join(dir, "src");
  mkdirSync(srcDir);
  process.env["CANOPY_TEST_BASE_URL"] = "https://example.com/v1";
  process.env["CANOPY_TEST_API_KEY"] = "test-key-abc123";
});

afterEach(() => {
  delete process.env["CANOPY_CONFIG"];
  delete process.env["CANOPY_TEST_BASE_URL"];
  delete process.env["CANOPY_TEST_API_KEY"];
});

describe("corpus 解析", () => {
  it("合法配置 + ${VAR} 展开", () => {
    writeConfig(validYaml());
    const cfg = resolveCorpus("test");
    expect(cfg.llm.baseURL).toBe("https://example.com/v1");
    expect(cfg.llm.apiKey).toBe("test-key-abc123");
    expect(cfg.source.dir).toBe(srcDir);
    expect(cfg.backend).toBe("memory");
  });

  it("配置文件不存在 → ConfigError（不自动生成默认配置）", () => {
    process.env["CANOPY_CONFIG"] = join(dir, "nope.yaml");
    expect(() => loadCorpora()).toThrow(ConfigError);
  });

  it("环境变量未定义 → 报错（不静默空串）", () => {
    delete process.env["CANOPY_TEST_API_KEY"];
    writeConfig(validYaml());
    expect(() => resolveCorpus("test")).toThrow(/CANOPY_TEST_API_KEY/);
  });

  it("未知键 → 报错（防 typo 静默失效）", () => {
    writeConfig(validYaml().replace("concurrency: 5", "concurrency: 5\n    debounceSecs: 3"));
    expect(() => loadCorpora()).toThrow(/未知配置键.*debounceSecs/);
  });

  it("llm 缺字段 → 报错", () => {
    writeConfig(validYaml().replace(/ *model: test-model\n/, ""));
    expect(() => loadCorpora()).toThrow(/model/);
  });

  it("source.dir 不存在 → 报错", () => {
    writeConfig(validYaml().replace(srcDir, join(dir, "ghost")));
    expect(() => loadCorpora()).toThrow(/不存在/);
  });

  it("backend 非法值 → 报错", () => {
    writeConfig(validYaml().replace("backend: memory", "backend: elasticsearch"));
    expect(() => loadCorpora()).toThrow(/memory \| sqlite/);
  });

  it("corpus 名重复 → 报错", () => {
    const dup = validYaml() + validYaml().replace("corpora:\n", "");
    writeConfig(dup);
    expect(() => loadCorpora()).toThrow(/重复/);
  });

  it("resolveCorpus 未注册名 → 列出可用名", () => {
    writeConfig(validYaml());
    expect(() => resolveCorpus("ghost")).toThrow(/可用: test/);
  });

  it("summaryTokenThreshold 非正整数 → 报错", () => {
    writeConfig(validYaml().replace("summaryTokenThreshold: 200", "summaryTokenThreshold: -1"));
    expect(() => loadCorpora()).toThrow(/正整数/);
  });
});
