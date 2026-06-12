// Canopy 数据契约唯一真相源（ADR-005）。
// 语料来源：molly.pageindex 实际产物 schema（ADR-006 字段清单，照真实字段抄）。
// emit：fsir ts-obj（扫 namespace Api）→ src/types/canopy.types.ts（只读，golden 钉死）。

namespace Api;

// ── 索引产物（*_structure.json，逐字段兼容 molly.pageindex，ADR-006）──

/** 文档树节点。node_id 为 4 位零填充字符串（先序重写，"0000" 起）。 */
model TreeNode {
  title: string;
  node_id: string;
  /** 1-based，heading 所在行 */
  line_num: int32;
  /** 叶节点摘要（<阈值时为原文，否则 LLM 生成） */
  summary?: string;
  /** 非叶节点摘要 */
  prefix_summary?: string;
  /** 节点正文（产物默认不含；内存树阶段在场） */
  text?: string;
  /** 子节点（空时字段省略，与 Python format_structure 行为一致） */
  nodes?: TreeNode[];
}

/** 索引产物顶层（<规范名>_structure.json）。 */
model DocStructure {
  /** 不含扩展名的源文件名 */
  doc_name: string;
  line_count: int32;
  structure: TreeNode[];
}

// ── corpus 配置（corpora.yaml 解析后形态）──

/** 检索后端（ADR-003） */
enum Backend {
  memory: "memory",
  sqlite: "sqlite",
}

model SourceSpec {
  /** 源目录（~ 已展开的绝对路径） */
  dir: string;
  glob: string;
  ignore: string[];
}

/** 结构化输出模式（Plexus OpenAICompatOpts.schema；json_schema 不被后端支持时
 *  Plexus 会降级 complete+hint 并 warn——显式配置可省掉每次 400 往返） */
enum SchemaMode {
  jsonSchema: "json_schema",
  jsonObject: "json_object",
  off: "off",
}

model LlmSpec {
  /** OpenAI 兼容端点基址（${VAR} 已展开，缺失即崩） */
  baseURL: string;
  apiKey: string;
  `model`: string;
  /** 文档化可选：缺省走 Plexus 默认（json_schema） */
  schema?: SchemaMode;
}

model CorpusConfig {
  name: string;
  source: SourceSpec;
  /** 索引产物目录（兼容 molly.pageindex 既有产物，ADR-006） */
  resultsDir: string;
  backend: Backend;
  llm: LlmSpec;
  /** 叶节点摘要阈值（token），低于阈值用原文 */
  summaryTokenThreshold: int32;
  /** stage-2 / 摘要并发限幅 */
  concurrency: int32;
  /** 单文件索引超时秒数（文档化可选，缺省 300） */
  timeoutSec?: int32;
  /** watch 防抖秒数（文档化可选，缺省 2） */
  debounceSec?: int32;
}

// ── CLI --json 输出契约（ADR-004）──

/** canopy find 单条命中（stage-1 BM25） */
model FindResult {
  /** 笔记名（产物文件名还原的 stem） */
  note_name: string;
  /** 产物文件名（<规范名>_structure.json） */
  filename: string;
  bm25_score: float64;
}

model FindResponse {
  query: string;
  corpus: string;
  results: FindResult[];
}

/** stage-2 命中节点 */
model NodeHit {
  node_id: string;
  title: string;
  summary: string;
}

/** canopy search 单文档命中（两阶段） */
model SearchHit {
  note_name: string;
  filename: string;
  bm25_score: float64;
  hits: NodeHit[];
}

model SearchResponse {
  query: string;
  corpus: string;
  results: SearchHit[];
  /** 答案合成（--no-answer 或 --json 结构化模式时省略） */
  answer?: string;
}

model GrepMatch {
  /** 相对 corpus 根的源文件路径 */
  file: string;
  line_num: int32;
  line: string;
}

model GrepResponse {
  pattern: string;
  corpus: string;
  matches: GrepMatch[];
}

/** 单文件索引结局 */
enum IndexOutcome {
  ok: "ok",
  skippedUnchanged: "skipped-unchanged",
}

model IndexReport {
  /** 源文件绝对路径 */
  file: string;
  outcome: IndexOutcome;
  result_path: string;
}

model BatchFailure {
  file: string;
  error: string;
}

model BatchReport {
  corpus: string;
  indexed: int32;
  skipped: int32;
  failed: int32;
  failures: BatchFailure[];
  /** 源已删被清理的产物文件名 */
  orphans_removed: string[];
}

model CorpusInfo {
  name: string;
  source_dir: string;
  results_dir: string;
  backend: Backend;
  /** resultsDir 中产物数 */
  doc_count: int32;
}

model CorporaResponse {
  corpora: CorpusInfo[];
}
