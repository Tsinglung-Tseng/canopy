# Canopy 对外兼容承诺（Compatibility Contract）

本页冻结 Canopy 对外的全部兼容面。列在这里的格式与签名是承诺：破坏性变更需要
major 版本号 + 迁移说明；未列出的一切（内部模块结构、日志措辞、stderr 内容、
`.canopy-state.json` 增量侧车）都不是契约，随时可变。

类型层面的唯一真相源是 [`ir/canopy.tsp`](ir/canopy.tsp) 的 `namespace Api`
（emit 到 `src/types/canopy.types.ts`，golden 钉死）；本页是其人话版。

## 1. 索引产物格式（`*_structure.json`，ADR-006）

每个源 markdown 对应一个产物文件，与 molly.pageindex 既有产物**逐字段兼容**
（既有索引零重建收养）：

```
{ doc_name: string,            // 不含扩展名的源文件名
  line_count: number,
  structure: TreeNode[] }

TreeNode = { title: string,
             node_id: string,    // 4 位零填充，build_tree 文档序 1-based（"0001" 起）
             line_num: number,   // 1-based，heading 所在行
             text?: string,      // 节点正文（生产事实格式：保留在产物中）
             nodes?: TreeNode[], // 空时整个字段省略
             summary?: string,        // 叶节点摘要（<阈值时为原文）；键序在末尾
             prefix_summary?: string  // 非叶节点摘要；键序在末尾
           }
```

- **键序是契约的一部分**（字节级兼容）：`title, node_id, line_num, text, nodes`，
  summary 类字段追加在末尾。
- **序列化字节格式**：`JSON.stringify(x, null, 2)` ≡ Python
  `json.dumps(x, indent=2, ensure_ascii=False)`（逐字节 roundtrip 实测）。

### 规范名规则（产物文件名）

源文件相对 corpus 根的路径 → `/` 替换为 `__`、空格替换为 `_`、去扩展名、
加后缀 `_structure.json`。例：`sub dir/我的 笔记.md` →
`sub_dir__我的_笔记_structure.json`。必须用完整相对路径而非裸 basename
（裸名会让嵌套同名笔记产生双份索引——历史坑的修复，不可回退）。

### 增量判定

源文件 md5 比对；产物存在但无 md5 记录时首扫收养（不重建）。状态侧车
`<resultsDir>/.canopy-state.json` 是内部实现，**不是契约**。

## 2. CLI `--json` 契约（ADR-004）

所有查询/索引命令支持 `--json`：**stdout 只输出一个 JSON 文档**，日志一律
stderr。退出码：`0` 成功（含零命中——空结果不是错误）；`1` 运行错误；
`2` 用法/配置错误。

| 命令 | `--json` 输出（Api 模型） |
|---|---|
| `canopy find --corpus X <query>` | `FindResponse { query, corpus, results: [{ note_name, filename, bm25_score }] }` |
| `canopy search --corpus X <query>` | `SearchResponse { query, corpus, results: [{ note_name, filename, bm25_score, hits: [{ node_id, title, summary }] }], answer? }`（`answer` 仅 `--answer` 时出现） |
| `canopy grep --corpus X <pattern>` | `GrepResponse { pattern, corpus, matches: [{ file, line_num, line }] }` |
| `canopy index --corpus X --file <md>` | `IndexReport { file, outcome: "ok"\|"skipped-unchanged", result_path }` |
| `canopy batch --corpus X` | `BatchReport { corpus, indexed, skipped, failed, failures: [{ file, error }], orphans_removed }` |
| `canopy corpora` | `{ corpora: CorpusInfo[] }`，`CorpusInfo { name, source_dir, results_dir, backend, doc_count }` |

## 3. MCP 工具面（`canopy mcp --corpus X`，stdio）

query-only server（唯一例外 `index_note`：同步单次、用户显式触发）。工具名与
签名与 molly.pageindex 的 MCP server 兼容（迁移零调用方改动）：

| 工具 | 入参 | 返回（text content） |
|---|---|---|
| `find_notes` | `query: string`, `top_k: int = 5` | 命中笔记名按行列出 |
| `search_notes` | `query: string`, `top_k: int = 5`, `lang: "en"\|"zh" = "en"` | 两阶段检索 + 答案合成 |
| `grep_notes` | `pattern: string`, `case_sensitive: bool = false`, `max_notes: int = 20`, `max_lines_per_note: int = 5` | 命中行按笔记分组 + 行号 |
| `index_note` | `md_path: string`, `force: bool = false` | `<outcome>: <result_path>` |

stdout 全程纯 JSON-RPC（无日志污染，测试以逐行 JSON.parse 断言）。

## 4. 配置文件（`corpora.yaml`）

路径：`CANOPY_CONFIG` 环境变量 > `~/.config/canopy/corpora.yaml`。找不到即报错，
不生成默认配置。已声明的键（schema 见 `ir/canopy.tsp` `CorpusConfig`）：

```yaml
corpora:
  - name: vault                  # 必填
    source:
      dir: ~/Documents/my-vault  # 必填
      glob: "**/*.md"            # 必填
      ignore: [".*/**"]          # 可选，默认 []
    resultsDir: ~/.local/share/canopy/results/vault   # 必填
    backend: memory              # 必填：memory | sqlite
    llm:
      baseURL: ${CANOPY_LLM_BASE_URL}   # 必填；${VAR} 未定义即报错
      apiKey: ${CANOPY_LLM_API_KEY}     # 必填
      model: deepseek-chat              # 必填
      schema: json_object        # 可选：json_schema(默认) | json_object | off
    summaryTokenThreshold: 200   # 必填
    concurrency: 5               # 必填
    timeoutSec: 300              # 可选
    debounceSec: 2               # 可选（watch）
```

未知键报错（防 typo 静默失效）；必填键缺失即崩（fail-loud，无静默默认）。

## 5. LLM 后端注入面（库消费，ADR-008）

`src/llm/kernel.ts` 的 `Llm` 接口是注入 seam：`complete(req)` 必备、
`completeSchema?(req)` 可选、`name?` 可选。任何实现该形状的对象（含 Plexus
后端实例）可传入 `indexFile`/`searchAgent` 等函数。该接口承诺保持
Plexus `Llm` 的结构子集。
