// corpus — corpora.yaml 多文本集注册与解析。解析即崩，不留到运行中（fail-loud）。
// 路径解析：CANOPY_CONFIG 环境变量 > ~/.config/canopy/corpora.yaml；找不到即报错退出，
// 不生成默认配置。${VAR} 展开为环境变量，未定义即报错（沿用 library-search 验证过的纪律）。
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Backend, CorpusConfig } from "./types/canopy.types.js";

/** 用法/配置错误：CLI 以退出码 2 处理（ADR-004）。 */
export class ConfigError extends Error {}

export function configPath(): string {
  const env = process.env["CANOPY_CONFIG"];
  if (env) return env;
  return join(homedir(), ".config/canopy/corpora.yaml");
}

function expandEnv(value: string, where: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new ConfigError(`${where}: 环境变量 \${${name}} 未定义（凭据从 ~/.zsh/secrets.zsh 注入，不写明文进 yaml）`);
    }
    return v;
  });
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

const CORPUS_KEYS = new Set([
  "name",
  "source",
  "resultsDir",
  "backend",
  "llm",
  "summaryTokenThreshold",
  "concurrency",
  "timeoutSec",
  "debounceSec",
]);
const SOURCE_KEYS = new Set(["dir", "glob", "ignore"]);
const LLM_KEYS = new Set(["baseURL", "apiKey", "model", "schema"]);

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw new ConfigError(`${where}: 未知配置键 [${unknown.join(", ")}]（防 typo 静默失效）`);
  }
}

function requireString(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new ConfigError(`${where}: 缺少或空的必填字段 '${key}'`);
  }
  return v;
}

function requireInt(obj: Record<string, unknown>, key: string, where: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new ConfigError(`${where}: '${key}' 必须是正整数（得到 ${JSON.stringify(v)}）`);
  }
  return v;
}

function optionalInt(obj: Record<string, unknown>, key: string, where: string): number | undefined {
  if (!(key in obj)) return undefined;
  return requireInt(obj, key, where);
}

function parseCorpus(raw: unknown, index: number): CorpusConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`corpora[${index}]: 必须是映射`);
  }
  const obj = raw as Record<string, unknown>;
  const name = requireString(obj, "name", `corpora[${index}]`);
  const where = `corpus '${name}'`;
  rejectUnknownKeys(obj, CORPUS_KEYS, where);

  const sourceRaw = obj["source"];
  if (!sourceRaw || typeof sourceRaw !== "object") throw new ConfigError(`${where}: 缺 source`);
  const source = sourceRaw as Record<string, unknown>;
  rejectUnknownKeys(source, SOURCE_KEYS, `${where}.source`);
  const dir = resolve(expandTilde(requireString(source, "dir", `${where}.source`)));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ConfigError(`${where}: source.dir 不存在或不是目录: ${dir}`);
  }
  const glob = requireString(source, "glob", `${where}.source`);
  const ignoreRaw = source["ignore"] ?? [];
  if (!Array.isArray(ignoreRaw) || ignoreRaw.some((x) => typeof x !== "string")) {
    throw new ConfigError(`${where}: source.ignore 必须是字符串数组`);
  }

  const resultsDir = resolve(expandTilde(requireString(obj, "resultsDir", where)));
  mkdirSync(resultsDir, { recursive: true }); // 校验"可创建"

  const backend = requireString(obj, "backend", where);
  if (backend !== "memory" && backend !== "sqlite") {
    throw new ConfigError(`${where}: backend 必须是 memory | sqlite（得到 '${backend}'）`);
  }

  const llmRaw = obj["llm"];
  if (!llmRaw || typeof llmRaw !== "object") throw new ConfigError(`${where}: 缺 llm（baseURL/apiKey/model）`);
  const llmObj = llmRaw as Record<string, unknown>;
  rejectUnknownKeys(llmObj, LLM_KEYS, `${where}.llm`);
  const llm: CorpusConfig["llm"] = {
    baseURL: expandEnv(requireString(llmObj, "baseURL", `${where}.llm`), `${where}.llm.baseURL`),
    apiKey: expandEnv(requireString(llmObj, "apiKey", `${where}.llm`), `${where}.llm.apiKey`),
    model: expandEnv(requireString(llmObj, "model", `${where}.llm`), `${where}.llm.model`),
  };
  if ("schema" in llmObj) {
    const schema = requireString(llmObj, "schema", `${where}.llm`);
    if (!["json_schema", "json_object", "off"].includes(schema)) {
      throw new ConfigError(`${where}.llm.schema 必须是 json_schema | json_object | off（得到 '${schema}'）`);
    }
    llm.schema = schema as CorpusConfig["llm"]["schema"];
  }

  const cfg: CorpusConfig = {
    name,
    source: { dir, glob, ignore: ignoreRaw as string[] },
    resultsDir,
    backend: backend as Backend,
    llm,
    summaryTokenThreshold: requireInt(obj, "summaryTokenThreshold", where),
    concurrency: requireInt(obj, "concurrency", where),
  };
  const timeoutSec = optionalInt(obj, "timeoutSec", where);
  if (timeoutSec !== undefined) cfg.timeoutSec = timeoutSec;
  const debounceSec = optionalInt(obj, "debounceSec", where);
  if (debounceSec !== undefined) cfg.debounceSec = debounceSec;
  return cfg;
}

export function loadCorpora(): Map<string, CorpusConfig> {
  const path = configPath();
  if (!existsSync(path)) {
    throw new ConfigError(
      `配置文件不存在: ${path}（设 CANOPY_CONFIG 或创建 ~/.config/canopy/corpora.yaml；不自动生成默认配置）`,
    );
  }
  const doc: unknown = parseYaml(readFileSync(path, "utf-8"));
  if (!doc || typeof doc !== "object" || !Array.isArray((doc as Record<string, unknown>)["corpora"])) {
    throw new ConfigError(`${path}: 顶层必须是 { corpora: [...] }`);
  }
  const out = new Map<string, CorpusConfig>();
  ((doc as Record<string, unknown>)["corpora"] as unknown[]).forEach((raw, i) => {
    const cfg = parseCorpus(raw, i);
    if (out.has(cfg.name)) throw new ConfigError(`corpus 名重复: '${cfg.name}'`);
    out.set(cfg.name, cfg);
  });
  return out;
}

export function resolveCorpus(name: string): CorpusConfig {
  const all = loadCorpora();
  const cfg = all.get(name);
  if (!cfg) {
    throw new ConfigError(`corpus '${name}' 未注册。可用: ${[...all.keys()].join(", ") || "(无)"}`);
  }
  return cfg;
}
