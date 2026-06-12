#!/usr/bin/env python3
"""合成 golden fixture 生成器（dev-only，重生成才需要跑）。

写出全合成的 markdown fixture，并用 molly.pageindex 的 Python 原版 md_to_tree
生成对照 golden（保持跨实现对照意义：golden 来自 Python，测试方是 TS mdToTree）。

调用参数复刻生产事实格式（ADR-006 / canopy golden 契约）：
  if_thinning=False, if_add_node_summary='no', if_add_node_text='yes',
  if_add_node_id='no'   # 生产链路 write_node_id 从未执行，node_id 为 build_tree 1-based

用法（需本地有 molly.pageindex 仓及其依赖环境）：
  cd <molly.pageindex>; uv run python <canopy>/scripts/gen-synthetic-fixtures.py \
      --pageindex . --out <canopy>/test/fixtures
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

# ── 合成 markdown 内容（全部虚构，不含任何真实笔记语料） ──────────────────────

def md_claude_workflow() -> str:
    sections = []
    sections.append("# AI 编码助手工作流对比\n\n本文虚构对比几款编码助手的使用流程，Claude Code 作为命令行代理的代表。\n")
    sections.append("## Claude Code 的会话模型\n\n" + "Claude Code 在终端里维持一个持续会话，工具调用与文件编辑都发生在工作目录内。上下文窗口是稀缺资源，长任务需要阶段性总结。 " * 12 + "\n")
    sections.append("### 权限模式\n\n" + "默认逐条确认，acceptEdits 自动接受编辑。claude code 的 hooks 可以在工具调用前后注入检查。 " * 10 + "\n")
    sections.append("### 子代理\n\n" + "把搜索类任务交给子代理可以保住主窗口的上下文预算。Claude Code 的 Task 工具即为此设计。 " * 10 + "\n")
    sections.append("## 与 IDE 插件的取舍\n\n" + "IDE 插件长于内联补全，命令行代理长于多步骤任务编排。两者互补而非互斥。 " * 12 + "\n")
    return "\n".join(sections)

def md_agent_pipeline() -> str:
    parts = ["# Agent 装配线笔记\n\n虚构的多代理装配线设计草稿，Claude Code 充当装配线的执行单元。\n"]
    for i in range(1, 7):
        parts.append(f"## 工位 {i}\n\n" + f"工位{i}负责把上游产物转换为下游输入，失败时整线停机（fail loud）。日志只进 stderr，stdout 保持纯净。 " * 8 + "\n")
        parts.append(f"### 工位 {i} 的验收\n\n" + "验收标准写成可执行断言，golden 文件钉死字节格式。 " * 6 + "\n")
    return "\n".join(parts)

def md_code_heavy() -> str:
    code_block = "```sql\n-- 建索引\nCREATE INDEX idx_notes ON notes USING bm25 (title, body);\n# 这行像 heading 但在代码块内\nSELECT * FROM notes WHERE body @@@ 'claude';\n```\n"
    py_block = "```python\n# 注释里的井号不是标题\ndef tokenize(text):\n    return [t for t in text.split() if t]\n# ## 也不是\n```\n"
    return (
        "# 全文索引示例库\n\n虚构数据库笔记，代码块密集。\n\n"
        "## DDL 片段\n\n" + code_block + "\n上面的代码块包含伪标题行，解析器必须忽略。\n\n"
        "## Python 侧消费\n\n" + py_block + "\n## 性能段\n\n" + "倒排索引的写放大与段合并策略相关，BM25 的 k1 与 b 参数控制词频饱和与长度归一。 " * 15 + "\n"
    )

def md_cli_guide() -> str:
    fence = "```bash\n# 安装\nnpm install -g example-cli\nexample-cli index --corpus demo\n```\n"
    return (
        "# 命令行工具示例指南\n\n虚构 CLI 指南，文件名模拟「目录__子目录_笔记」规范名形态。\n\n"
        "## 安装\n\n" + fence + "\n## 子命令\n\n### index\n\n建立索引，重复执行按 md5 跳过未变更源。\n\n### search\n\n两阶段检索：BM25 召回后由 LLM 选节点。\n\n"
        "## 退出码\n\n0 成功（含零命中）；1 运行错误；2 用法错误。\n"
    )

def md_long_transcript() -> str:
    parts = ["# 合成播客转写：检索系统漫谈\n\n（本转写为程序生成的虚构对话，用于大文件边界测试。）\n"]
    topics = ["倒排索引", "分词器", "向量召回", "重排序", "缓存策略", "增量更新", "评测集", "查询改写", "多语言", "成本控制"]
    for h, topic in enumerate(topics, 1):
        parts.append(f"## 第{h}节：{topic}\n")
        for p in range(30):
            parts.append(f"主持人：关于{topic}，第{p}个问题是它在大规模语料下的行为如何？\n")
            parts.append(f"嘉宾：{topic}的关键在于权衡。" + f"这是第{p}段虚构展开，讨论{topic}与系统其余部分的交互、失败模式、以及可观测性。 " * 6 + "\n")
        parts.append(f"### 第{h}节小结\n\n" + f"{topic}小结：先量化再优化。 " * 8 + "\n")
    return "\n".join(parts)

def md_no_headings() -> str:
    return "这篇笔记没有任何标题。\n\n" + "纯文本段落也必须能建树：整篇成为一个无标题根节点还是空结构，由解析器语义决定，golden 钉死。 " * 10 + "\n"

def md_single_line() -> str:
    return "只有一行且无结尾换行"

def md_empty() -> str:
    return ""

def md_heading_dense() -> str:
    return (
        "# 一级\n## 二级甲\n### 三级\n#### 四级\n##### 五级\n###### 六级\n## 二级乙\n# 另一个一级\n"
    )

def md_level_jumps() -> str:
    return (
        "# 顶层\n\n正文 A\n\n#### 直接跳到四级\n\n正文 B\n\n## 回到二级\n\n正文 C\n\n###### 再跳到六级\n\n正文 D\n\n### 回到三级\n\n正文 E\n"
    )

def md_frontmatter() -> str:
    return (
        "---\ntitle: 合成笔记\ntags: [test, synthetic]\ncreated: 2026-01-01\n---\n\n# 带 frontmatter 的笔记\n\nfrontmatter 的分隔线与键值不是标题。\n\n## 正文段\n\n" + "frontmatter 之后的结构照常解析。 " * 8 + "\n"
    )

def md_edge_cases() -> str:
    return (
        "\n\n# 前导空行后的标题\n\n#NoSpace 不是标题\n\n####### 七个井号不是标题\n\n    # 缩进四格不是标题\n\n## 末尾带空格的标题   \n\n正文。\n\n```\n# 未闭合代码块内的伪标题\n## 直到文件结尾都在块内\n"
    )

FIXTURES = {
    "AI_编码助手对比_Claude-Code-Workflow.md": md_claude_workflow,
    "AI_装配线笔记_Agent-Pipeline.md": md_agent_pipeline,
    "Database_合成示例_全文索引.md": md_code_heavy,
    "Tech__Tool_命令行示例_CLI-Guide.md": md_cli_guide,
    "中文长文_合成播客转写.md": md_long_transcript,
    "无标题纯文本.md": md_no_headings,
    "单行.md": md_single_line,
    "空文件.md": md_empty,
    "标题密集_无正文.md": md_heading_dense,
    "跳级与回退.md": md_level_jumps,
    "frontmatter_注意事项.md": md_frontmatter,
    "边角料_状态机.md": md_edge_cases,
}


async def generate(pageindex_repo: Path, out_dir: Path) -> None:
    sys.path.insert(0, str(pageindex_repo))
    from pageindex.page_index_md import md_to_tree  # noqa: E402

    md_dir = out_dir / "md"
    golden_dir = out_dir / "golden"
    md_dir.mkdir(parents=True, exist_ok=True)
    golden_dir.mkdir(parents=True, exist_ok=True)

    for name, fn in FIXTURES.items():
        md_path = md_dir / name
        md_path.write_text(fn(), encoding="utf-8")
        tree = await md_to_tree(
            str(md_path),
            if_thinning=False,
            if_add_node_summary="no",
            if_add_node_text="yes",
            if_add_node_id="no",
        )
        golden_path = golden_dir / (md_path.stem + "_structure.json")
        golden_path.write_text(json.dumps(tree, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"OK {name} -> {golden_path.name}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--pageindex", required=True, help="molly.pageindex 仓路径")
    ap.add_argument("--out", required=True, help="输出目录（test/fixtures）")
    args = ap.parse_args()
    asyncio.run(generate(Path(args.pageindex).resolve(), Path(args.out).resolve()))
