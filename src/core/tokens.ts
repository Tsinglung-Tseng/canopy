// token 计数 — 仅 thinning 与摘要阈值使用（不做计费）。
// Python 版走 litellm/tiktoken；这里用 js-tiktoken cl100k_base。
// 文档化容忍点（ADR-007 风险 1 / core.md）：与 litellm 按模型选择的编码可能有
// 少量逐 token 偏差，但只影响阈值判断（200/5000 级别），不影响树结构正确性。
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";

let enc: Tiktoken | null = null;

export function countTokens(text: string | undefined | null): number {
  if (!text) return 0;
  if (!enc) enc = new Tiktoken(cl100k_base);
  return enc.encode(text).length;
}
