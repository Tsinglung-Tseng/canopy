# Canopy 🌳

树状文档索引 + 两阶段检索（BM25 → LLM tree search）的独立 CLI 工具库，TypeScript 实现，以 **corpus** 为一等抽象——一套工具服务任意 markdown 文本集（Obsidian vault、书库、更大的外部文本集）。

核心由 [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex)（vectorless reasoning-based RAG）的思路出发、以 TypeScript 整体重写。索引产物格式与该 Python 原版逐字段兼容（含键序与序列化字节格式），既有索引零重建直接收养——对外兼容承诺见 [`COMPATIBILITY.md`](COMPATIBILITY.md)。

## 快速开始

```bash
npm install && npm run build && npm link   # 得到全局 canopy 命令
make test                                  # typecheck + 100 测试用例
```

配置（`CANOPY_CONFIG` 环境变量 > `~/.config/canopy/corpora.yaml`，找不到即报错，无静默默认）：

```yaml
corpora:
  - name: vault
    source:
      dir: ~/Documents/my-vault
      glob: "**/*.md"
      ignore: [".*/**"]
    resultsDir: ~/.local/share/canopy/results/vault
    backend: memory
    llm:
      baseURL: ${CANOPY_LLM_BASE_URL}   # 任意 OpenAI 兼容端点
      apiKey: ${CANOPY_LLM_API_KEY}
      model: deepseek-chat
      schema: json_object               # DeepSeek 用 json_object；默认 json_schema
    summaryTokenThreshold: 200
    concurrency: 5
```

```bash
canopy corpora                             # 列出 corpus + 健康度
canopy index  --corpus vault [--file x.md] # 增量索引（md5 跳过未变更；节点级摘要复用）
canopy find   --corpus vault "查询词"       # stage-1 BM25（无 LLM，快）
canopy search --corpus vault "查询词" --lang zh   # 两阶段 + 答案合成
canopy grep   --corpus vault "正则"         # 直扫源文件
canopy mcp    --corpus vault               # query-only stdio MCP server
canopy watch  --corpus vault               # 常驻 watcher（单实例）
```

所有查询/索引命令支持 `--json`（stdout 单 JSON 文档，日志只进 stderr）；退出码 0 成功（含零命中）/ 1 运行错误 / 2 用法配置错误。

## 设计要点

- **两阶段检索**：BM25（jieba 中文分词）召回 top-k 文档 → LLM 在文档树骨架上选相关节点 → 可选答案合成。树是真相源，无向量库。
- **增量到节点级**：源 md5 跳过未变更文件；重索引时按 `md5(节点正文)` 复用既有产物里未变节点的摘要，只重烧真正改动的节点（frontmatter 小改不再触发全文档重生成）。
- **fail loud**：配置缺失即崩、预算超限即崩、无静默兜底。
- **日志三铁律**：库代码不落盘；落盘强制轮转（10MB×3）；stdout 纯净（MCP/--json 可执行断言）。
- **零外部 LLM SDK**：`src/llm/kernel.ts` 自带最小编排内核 + OpenAI-compatible 后端（全局 fetch）；任何实现 `complete()` 的对象可注入（ADR-008）。

## 文档地图

- **对外兼容承诺：[`COMPATIBILITY.md`](COMPATIBILITY.md)**（产物格式/规范名/CLI --json/MCP 工具面/配置键）
- 计划与里程碑：`docs/project/dev-plan.md` · 变更时间线：`docs/project/CHANGELOG.md`
- 模块设计（10 篇）：`docs/modules/` · 架构决策（ADR 001–008）：`docs/decisions/`

## 类型生成（维护者）

`src/types/canopy.types.ts` 由 `ir/canopy.tsp`（TypeSpec）生成并已落仓，golden 钉死；
无生成工具链时 `make ir-check` 自动降级为 golden diff。

> 命名谱系：Aquifer（含水层）· 石笋（fullStackIR）· Plexus（神经丛）→ **Canopy**（树冠层），文档树的顶视图。
