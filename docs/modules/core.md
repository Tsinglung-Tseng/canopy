# core — markdown → 文档树

状态：已实现（`src/core/tree.ts` + `src/core/tokens.ts`，2026-06-11；golden 16 fixture + 全量 2319 源 100% 全等）

## 职责

把一篇 markdown 解析成层级文档树（`DocStructure`）。**纯函数、无 LLM、无 IO**——LLM 摘要由 [llm](llm.md) 模块在树上做第二遍。移植自 `molly.pageindex/pageindex/page_index_md.py`。

## 架构

```
parse(markdownText): { nodes, lines }     // heading 扫描
  └─ 规则：^#{1,6} 匹配；``` 代码块内的 # 忽略（状态机翻转 in_code_block）
extractText(nodes, lines): NodeWithText[] // 每节点文本 = 自身 heading 行到下一 heading 前
thinning(nodes, minTokens)?: ...          // 可选：小节点向父节点合并（现行生产链路未启用，移植但默认关）
buildTree(nodes): TreeNode[]              // 栈式按 level 建树；node_id 4 位零填充（"0001" 起）
```

输出 schema 见 ADR-006；类型由 `ir/canopy.tsp` emit（ADR-005）。

## 关键实现注意

- **node_id 编号语义（M2 golden 实测修订）**：既有产物全部是 `build_tree_from_nodes` 的 **1-based**（"0001" 起）文档序编号——`write_node_id`（0-based 重写）在生产链路**从未执行过**：`run_pageindex.py` md 分支把 CLI 未传的 `if_add_node_id=None` 直接覆盖进 config（不过滤 None），`None != 'yes'` 短路。同因：产物**保留 text 字段**（`if_add_node_text=None != 'no'`），summary/prefix_summary 生成后**追加在键序末尾**。该事实格式即 ADR-006 兼容契约；TS 版 mdToTree 不调 writeNodeId（函数保留导出仅作对照），golden 锁死。
- token 计数仅 thinning 和摘要阈值用。Python 版走 litellm/tiktoken；TS 版用 `js-tiktoken`，cl100k 近似即可——只做阈值判断不做计费，少量偏差可容忍（在代码注释里写明这是文档化的容忍点）。
- heading 正则要求 `#` 后有空格（`^#{1,6}\s+`），与 Python 版一致；frontmatter 区（`---` 包围）不含 heading 时天然无影响，不必特判。

## 接口

`mdToTree(text: string, opts: { thinning?: boolean; minTokens?: number }): DocStructure`（不含 summary 字段——摘要是 llm 模块的事）

## 依赖

js-tiktoken（仅 thinning 路径）。无其他依赖。

## 测试策略（M2 golden）

从 molly.pageindex `results/RPG/` 抽 10–20 个代表性产物（含中文名、嵌套目录、代码块重的笔记），对源 .md 跑 `mdToTree`，与既有 JSON 去掉 `summary`/`prefix_summary` 后逐字段比对。差异 = bug，不许"差不多"。

## 已知问题

- setext heading（`===`/`---` 下划线式）两版都不支持，维持不支持。
- Python 版对 `nodes` 空数组时字段省略（`format_structure` 行为），TS 版须复刻该省略逻辑，否则 golden diff 不过。
