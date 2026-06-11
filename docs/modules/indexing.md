# indexing — 规范名、增量、落盘

状态：设计完成（未开始编码）

## 职责

单文件索引的完整生命周期：源 .md → core 建树 → llm 摘要 → 写入 resultsDir 规范名 JSON。批量模式（batch）遍历 corpus 全量做增量。

## 关键实现

- **规范名**（ADR-006，照搬 `get_result_path` 修复后的语义）：相对 corpus 根路径，`/`→`__`、空格→`_`、去扩展名 + `_structure.json`。直接写最终路径，**没有"先裸名再改名"的中间态**（旧实现 run_pageindex 按裸 basename 落盘再 rename 的坑直接消灭）。
- **增量判定**：源文件 md5 vs 上次索引时记录。md5 存放：首版沿用"重算源文件 md5 + 检查产物存在且含 structure 键"的旧语义，保证与既有 47 MB 产物互操作；sqlite 后端（M8）落表。
- **原子写**：先写 `<name>.tmp` 再 rename，防止查询端读到半个 JSON。
- **超时**：单文件索引超时上限（旧值 300s）由 corpus 配置覆盖；超时是真错误（非 0 退出 + stderr）。

## 接口

`indexFile(corpus, mdPath, opts): Promise<IndexOutcome>`   // 'ok' | 'skipped-unchanged' | throw
`indexBatch(corpus, opts): Promise<BatchReport>`            // 含 indexed/skipped/failed 计数，失败明细
`cleanupOrphans(corpus): Promise<string[]>`                 // 源已删的产物清理，列出后删除

## 依赖

core、llm、corpus。

## 已知问题

- iCloud vault 的 bird 失控期（vault 记忆：mmap deadlock）对读源文件同样有风险——batch 失败时按文件计入 failed 继续跑完再报（fail loud at end, not fail half），与 Aquifer refresh 的"完成所有工作再 fail"模式一致。
