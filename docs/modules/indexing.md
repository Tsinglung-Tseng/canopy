# indexing — 规范名、增量、落盘

状态：已实现（src/indexing.ts，2026-06-11）

## 职责

单文件索引的完整生命周期：源 .md → core 建树 → llm 摘要 → 写入 resultsDir 规范名 JSON。批量模式（batch）遍历 corpus 全量做增量。

## 关键实现

- **规范名**（ADR-006，照搬 `get_result_path` 修复后的语义）：相对 corpus 根路径，`/`→`__`、空格→`_`、去扩展名 + `_structure.json`。直接写最终路径，**没有"先裸名再改名"的中间态**（旧实现 run_pageindex 按裸 basename 落盘再 rename 的坑直接消灭）。
- **增量判定**：源文件 md5 vs 上次索引时记录。md5 存放：首版沿用"重算源文件 md5 + 检查产物存在且含 structure 键"的旧语义，保证与既有 47 MB 产物互操作；sqlite 后端（M8）落表。
- **原子写**：先写 `<name>.tmp` 再 rename，防止查询端读到半个 JSON。
- **兼容序列化器**（ADR-007 风险 3）：产物须与 Python `json.dumps` 既有格式混读混写——读端对键序/缩进宽容，写端固定一种与既有产物 diff 友好的格式并在 golden 里钉死。序列化器归本模块，core 只产内存树不碰 JSON 文本。
- **超时**：单文件索引超时上限（旧值 300s）由 corpus 配置覆盖；超时是真错误（非 0 退出 + stderr）。
- **节点级摘要复用**（M8.5）：重索引（md5 不匹配、非收养、非 `--force`）时从既有产物建 `md5(节点正文)→既往摘要` 缓存（`buildSummaryCache`），新树中正文逐字未变且仍在 LLM 路径（≥阈值）的节点直接复用、跳过 LLM 调用。匹配键是**正文 md5**而非 node_id（node_id 是先序位置编号，插入/删除 heading 会整体偏移）。缓存只收录 `summary/prefix_summary !== text` 的条目（真烧过 LLM 的节点），阈值以下原文摘要零成本重算、不入缓存——避免阈值变更时把原文形态误当 LLM 摘要复用。摘要是正文的纯函数（与叶/非叶无关），复用值落到 `summary` 还是 `prefix_summary` 由新树层级决定。损坏产物 → 无缓存、退化为全量重生成（安全）。动机：tagger 回写、frontmatter 小改当前会触发整篇摘要重生成（大笔记一次 33 调用），复用后只重烧真正变更的节点。

## 接口

`indexFile(corpus, mdPath, opts): Promise<IndexOutcome>`   // 'ok' | 'skipped-unchanged' | throw
`indexBatch(corpus, opts): Promise<BatchReport>`            // 含 indexed/skipped/failed 计数，失败明细
`cleanupOrphans(corpus): Promise<string[]>`                 // 源已删的产物清理，列出后删除

## 依赖

core、llm、corpus。

## 已知问题

- iCloud vault 的 bird 失控期（vault 记忆：mmap deadlock）对读源文件同样有风险——batch 失败时按文件计入 failed 继续跑完再报（fail loud at end, not fail half），与 Aquifer refresh 的"完成所有工作再 fail"模式一致。
