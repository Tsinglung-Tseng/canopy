// grep — 正则直扫源文件（canopy grep / MCP grep_notes 同源实现）。
// 点目录在 listSourceFiles 层跳过（旧实现已修的坑：worktrees 副本让同一笔记重复命中）。
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { CorpusConfig, GrepMatch } from "./types/canopy.types.js";
import { listSourceFiles } from "./indexing.js";

export interface GrepOpts {
  caseSensitive?: boolean;
  maxNotes?: number; // 命中文件数上限（对齐旧 grep_notes 默认 20）
  maxLinesPerNote?: number; // 每文件命中行上限（默认 5）
}

export function grepCorpus(corpus: CorpusConfig, pattern: string, opts: GrepOpts = {}): GrepMatch[] {
  const maxNotes = opts.maxNotes ?? 20;
  const maxLinesPerNote = opts.maxLinesPerNote ?? 5;
  // 非法正则 → throw（用法错误，CLI 退出码 2）
  const re = new RegExp(pattern, opts.caseSensitive ? "" : "i");

  const matches: GrepMatch[] = [];
  let noteCount = 0;
  for (const file of listSourceFiles(corpus)) {
    if (noteCount >= maxNotes) break;
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue; // 瞬态：扫描间文件被删（iCloud vault 常态），跳过
    }
    const lines = content.split("\n");
    let inNote = 0;
    for (let i = 0; i < lines.length; i++) {
      if (inNote >= maxLinesPerNote) break;
      if (re.test(lines[i] as string)) {
        matches.push({
          file: relative(corpus.source.dir, file),
          line_num: i + 1,
          line: (lines[i] as string).trim(),
        });
        inNote++;
      }
    }
    if (inNote > 0) noteCount++;
  }
  return matches;
}
