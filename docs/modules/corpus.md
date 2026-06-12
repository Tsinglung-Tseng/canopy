# corpus — 多文本集注册与解析

状态：已实现（src/corpus.ts，2026-06-11）

## 职责

corpus = Canopy 的一等抽象：一个文本集的全部配置。解析 `corpora.yaml`，向其余模块提供已校验的 `CorpusConfig`（类型由 ir/canopy.tsp 定义）。

## 配置文件

路径解析顺序：`CANOPY_CONFIG` 环境变量 > `~/.config/canopy/corpora.yaml`。**找不到即报错退出**，不生成默认配置（fail-loud）。

```yaml
corpora:
  - name: vault
    source:
      dir: ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/RPG
      glob: "**/*.md"
      ignore: [".*/**"]            # 点目录（.claude/.obsidian/...）一律不进
    resultsDir: ~/scaffold/molly.pageindex/results/RPG   # 兼容既有产物（ADR-006）
    backend: memory                # memory | sqlite（ADR-003）
    llm:
      baseURL: ${CANOPY_LLM_BASE_URL}
      apiKey: ${CANOPY_LLM_API_KEY}
      model: deepseek-v4-flash
    summaryTokenThreshold: 200
    concurrency: 5
```

- `${VAR}` 展开为环境变量，**未定义即报错**（沿用 library-search 已验证的纪律与写法）。
- 凭据永不写明文进 yaml；从 `~/.zsh/secrets.zsh` 注入。

## 接口

`loadCorpora(): Map<string, CorpusConfig>`
`resolveCorpus(name: string): CorpusConfig`（不存在 → 报错列出可用名）

## 校验规则（解析即崩，不留到运行中）

source.dir 存在；resultsDir 可创建；llm 三字段非空；name 唯一；未知 key 报错（防 typo 静默失效）。

## 已知问题

- readers 书库的"源"不是目录而是 books.db 里的 mineru md 路径集——首版 corpus 只支持目录型 source，readers 迁移走 CLI 单文件模式（`canopy index --file`，见 migration.md），目录型之外的 source 类型等第二个真实证据再加（不预先抽象）。
