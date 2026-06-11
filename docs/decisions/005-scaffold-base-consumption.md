# ADR-005 基座消费方式：fsir 发 types，Plexus 直接 import（无 sidecar）

## 背景

按 /scaffold 基座消费规范，本地项目只持有"声明式定义 + agent 代码 + Makefile"，元语住基座。Canopy 本身是 TS，这改变了 Plexus 的标准接法（规范里的 sidecar 模式是为非 TS 后端设计的）。

## 决策

**obj 侧（石笋 fullStackIR）**：
- `ir/canopy.tsp` 是数据契约唯一真相源，定义：`TreeNode`（node_id/title/text/line_num/summary/prefix_summary/nodes 递归）、`DocStructure`（doc_name/line_count/structure，即 `*_structure.json` 顶层）、`CorpusConfig`、`namespace Api` 下的 `SearchHit`/`FindResult`/`GrepMatch`（`--json` 输出契约）。
- ts-obj emit → `src/types/canopy.types.ts`，带只读头；钉 `golden/canopy.types.ts`；`make ir-check` = 重生成 + `git diff --exit-code`。
- 语料来源（规范第 1 步"抽语料，照真实字段抄"）：molly.pageindex 实际产物 schema 已核实——见 ADR-006 字段清单。

**agent 侧（Plexus）**：
- 直接 `"plexus": "file:~/scaffold/Plexus"` 依赖，**不做 sidecar**——sidecar 是跨语言桥，同语言直接 import 是规范允许的更短路径。
- 消费原语映射（替换 Python 旧实现的对应物）：
  | Python 旧实现 | Plexus 原语 |
  |---|---|
  | `llm_completion` 手写 retry×10 | `ask` |
  | `extract_json` 正则修补 LLM 输出 | `askSchema`（tool-call 强制结构化） |
  | `ThreadPoolExecutor(max_workers=5)` | `par` |
  | 无 token 上限（裸跑） | `Budget` fail-loud |
  | 无确定性测试 | MockLlm + vitest |
- Makefile：`agents-typecheck`（tsc --noEmit）/ `agents-test`（vitest，MockLlm）。

**铁律继承**：缺 obj 元语 → 回 fsir 走加功能流程（≥2 证据）；缺 agent 元语 → 回 Plexus 走 proposal→ADR→additive 实现；本地永不私接。

## 理由

Canopy 的 LLM 编排（并发节点摘要、stage-2 选择、合成）正是 Plexus 七原语的标准形状；Python 旧代码里手写的 retry/解析/并发全部是 Plexus 已解决的问题，重写即偿还。数据契约走 fsir 保证 `--json` 输出（ADR-004）与内部类型同源不漂移。
