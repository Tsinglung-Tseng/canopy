# ADR-008 自带最小 LLM kernel：Plexus 从硬依赖降级为可选注入

## 背景

交付方式变更：canopy 开发完成后整体移植到 molly.pageindex（已开源仓）对外发布。
package.json 里 `"plexus": "file:../Plexus"` 是私有路径依赖，外部用户 `npm install`
直接失败——开源阻断项。ADR-005 的"Plexus 直接 import"决策在此前提下不再成立。

## 决策

**部分推翻 ADR-005 的 agent 侧接法**（obj 侧 fsir 不受影响）：

1. **内联最小 kernel**（`src/llm/kernel.ts`，零依赖）：Canopy 实际消费的 Plexus
   子集——`Cost/Outcome/ok/fail`、`Budget/BudgetExhausted`（fail-loud 见底 throw）、
   `Ctx/Agent/makeCtx`、`ask/askSchema/par`、`run`。语义与 Plexus 同名原语一致
   （askSchema 的 completeSchema feature-detect + prompt-hint 降级、par 返回
   Outcome[] 不静默丢失败、预算超限 throw 而非 Outcome.fail）。
2. **零依赖默认后端**（`src/llm/openai.ts`）：OpenAICompatLlm，全局 fetch 无 SDK，
   baseURL/model/apiKey 三轴必填无默认；`schema: json_schema|json_object|off`
   三模式保留（DeepSeek 兼容关键）。
3. **MockLlm 内联**（`src/llm/mock.ts`）：确定性免 key 测试后端。
4. **Plexus 降级为可选增强**：kernel 的 `Llm` 接口（`complete` 必备、
   `completeSchema` 可选、`name` 可选）是 Plexus `Llm` 的**结构子集**——Plexus 的
   OpenAICompatLlm/DeepSeekLlm/AnthropicLlm 实例靠 TS 结构类型直接满足 canopy 的
   seam，本机开发要 recorder/eventstore/coordinate 能力时在调用侧构造传入即可，
   **无需任何 plexus import**。package.json 不再含 plexus。

## 不内联的面（Canopy 不消费，刻意不搬）

streaming、tool-use、recorder/eventstore、coordinate cube、sub-budget、
workflow/memory/journal/trace。需要时回 Plexus 用，不在 canopy 里长出第二个 Plexus。

## 铁律的再解释

ADR-005"元语缺口回基座做不本地私接"仍然有效，但适用对象变了：kernel 是**已有
Plexus 元语的发布用内联拷贝**（接口同形），不是私造新元语。kernel 若需新能力，
先回 Plexus 设计验证，再同步内联——Plexus 仍是这些原语的上游真相源。

## 实测验收（2026-06-12）

- typecheck + 95 用例全绿（MockLlm 路径零行为变化）。
- 真 DeepSeek e2e：batch 索引 3 文档（3 次摘要调用）+ 中文两阶段检索 + 答案合成，
  exit 0。
- 顺手修复：stage-2 prompt 补 "JSON" 一词——DeepSeek json_object 模式要求 prompt
  含 "json" 字样，否则每次 stage-2 仍有一个 400 降级往返；修后零 warn 零降级。
