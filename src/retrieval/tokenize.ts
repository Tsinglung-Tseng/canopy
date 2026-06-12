// 分词 — 移植 molly.pageindex retrieval.py:_tokenize，行为逐字符对齐。
// CJK 串走 jieba 词级切分（不逐字！单字 IDF 刷分 bug 两个旧仓都修过，必须保住）。
import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict.js";

let jieba: Jieba | null = null;
function getJieba(): Jieba {
  if (!jieba) jieba = Jieba.withDict(dict);
  return jieba;
}

// Python string.punctuation + '，。！？；：、（）【】《》'（实测 retrieval.py:62 字符集，
// 注意：源码里没有弯引号——retrieval.md 文档与代码不符时以代码为准）+ \n\r\t
const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~" + "，。！？；：、（）【】《》" + "\n\r\t";
const PUNCT_SET = new Set(PUNCT);

const CJK_RE = /[一-鿿]/;

export function tokenize(text: string): string[] {
  let cleaned = "";
  for (const ch of text.toLowerCase()) {
    cleaned += PUNCT_SET.has(ch) ? " " : ch;
  }
  const tokens: string[] = [];
  for (const token of cleaned.split(/\s+/)) {
    if (!token) continue;
    if (CJK_RE.test(token)) {
      for (const w of getJieba().cut(token, false)) {
        if (w.trim()) tokens.push(w);
      }
    } else {
      tokens.push(token);
    }
  }
  return tokens;
}
