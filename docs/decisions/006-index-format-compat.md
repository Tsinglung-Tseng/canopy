# ADR-006 索引产物格式与 molly.pageindex 兼容

## 背景

molly.pageindex `results/` 已有 47 MB 既有索引（RPG vault + ZenOfCS），readers.myapp 的 `pageindex_trees` 表也存同构树 JSON。重建全部索引要烧一遍 LLM 摘要费用且耗时数小时。

## 决策

Canopy 读写的索引产物**逐字段兼容**既有格式，迁移期零重建：

**文件 schema**（`<规范名>_structure.json`，实测自 molly.pageindex 产物）：
```
{ doc_name: string,            // 不含扩展名的源文件名
  line_count: number,
  structure: TreeNode[] }
TreeNode = { title, node_id,   // 4 位零填充字符串 "0001"
             line_num,         // 1-based，heading 所在行
             summary?,         // 叶节点（>200 token 才 LLM 生成，否则原文）
             prefix_summary?,  // 非叶节点
             nodes?: TreeNode[] }
```

**规范名规则**（同 molly.pageindex `get_result_path`）：源文件相对 corpus 根的路径，`/`→`__`、空格→`_`、去扩展名、后缀 `_structure.json`。注意保留历史坑的修复：必须用完整相对路径而非裸 basename（裸名会让带空格/嵌套的笔记产生双份索引）。

**增量判定**：源文件 md5 比对（与现实现一致）。

**约束**：M8 的 SQLite FTS5 后端是检索加速层，JSON 树文件仍是真相源（LLM tree search 需要完整树）；FTS5 索引可随时从 JSON 重建。

## 理由

47 MB 产物即资产；格式兼容让 M6/M7 的消费方切换是纯指针切换（MCP 注册、startCmd、adapter），不动数据。schema 同时进 `ir/canopy.tsp` 成为受 golden 保护的契约（ADR-005），从"事实格式"升级为"声明格式"。
