# llm — Plexus 编排层

状态：已实现（src/llm/（agents/provider）+ src/search.ts，2026-06-11）

## 职责

Canopy 所有 LLM 调用的唯一出口，基于 Plexus 原语组合（ADR-005）。三个 agent：

1. **summarize**：对树上每个节点生成摘要。叶节点 <200 token 直接用原文（不调 LLM）；否则 `ask` 生成。全树 `par` 并发。非叶节点写 `prefix_summary`，叶节点写 `summary`（与既有产物字段对齐）。
2. **selectNodes**（检索 stage-2）：给定 query + 文档树骨架（id/title/summary），`askSchema` 返回相关 node_id 数组——schema 强制 `string[]`，彻底替代 Python 版 `extract_json` 的正则修补。
3. **synthesize**：把命中节点的内容拼上下文，`ask` 合成最终回答（`search` 命令的 answer 模式；`--json` 结构化模式可跳过此步）。

## 架构

```
src/llm/
  agents.ts      // summarize / selectNodes / synthesize（Kleisli 组合）
  provider.ts    // Llm 后端构造：从 corpus 配置读 baseURL/apiKey/model
```

- Budget：每次 index/search 顶层挂 `Budget`，超限 throw（fail-loud），CLI 把已花费 Cost 打到 stderr 摘要。
- 并发：`par` 限幅沿用现行经验值（摘要全节点并发、stage-2 文档级 ≤5），写进 corpus 配置可调。

## 接口

`buildSummaries(doc: DocStructure, llm, budget): Promise<DocStructure>`
`selectRelevantNodes(query, docSkeleton, llm): Promise<string[]>`
`synthesizeAnswer(query, contexts, lang, llm): Promise<string>`

## 依赖

plexus（file:~/scaffold/Plexus）。模型/凭据从 corpus 配置注入，**无任何硬编码默认**（缺失即崩，CLAUDE.md 纪律）。

## 测试策略

MockLlm 确定性测试：摘要字段落位（summary vs prefix_summary）、阈值分支、askSchema 拒绝畸形输出、Budget 见底 throw。真实后端 e2e 一条（DeepSeek，注意 deepseek 思考模型需关思考或查 finish_reason=length，见 vault 既有教训）。

## 已知问题

- readers.myapp 现有 `llm_cache`（LLM 调用结果落库缓存）在 Canopy 首版不提供对应物；readers 迁移后重复建树会真调 LLM。M7 评估是否需要在 Plexus 层加缓存 seam（若加，回 Plexus 走 proposal 流程，不本地私接）。
