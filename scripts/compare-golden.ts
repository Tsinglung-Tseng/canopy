// 离线全量对照：vault 源 .md → mdToTree → 与 molly.pageindex 既有产物
// （去 summary/prefix_summary 后）deep-equal。M2 验收的证据采集器。
// 用法: npx tsx scripts/compare-golden.ts <vaultDir> <resultsDir> [limit]
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { mdToTree } from "../src/core/tree.js";

const [vaultDir, resultsDir, limitStr] = process.argv.slice(2);
if (!vaultDir || !resultsDir) {
  console.error("usage: tsx scripts/compare-golden.ts <vaultDir> <resultsDir> [limit]");
  process.exit(2);
}
const limit = limitStr ? parseInt(limitStr, 10) : Infinity;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // 点目录不进索引（设计一致）
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith(".md")) yield p;
  }
}

function canonicalName(vault: string, mdPath: string): string {
  const rel = relative(vault, mdPath);
  const safe = rel.replaceAll("/", "__").replaceAll(" ", "_");
  return safe.replace(/\.md$/, "") + "_structure.json";
}

/** 递归去掉 summary/prefix_summary（LLM 字段，core 不产）。 */
function stripSummaries(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSummaries);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "summary" || k === "prefix_summary") continue;
      out[k] = stripSummaries(v);
    }
    return out;
  }
  return node;
}

function deepEqual(a: unknown, b: unknown, path = ""): string | null {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: array len ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = deepEqual(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.join(",") !== kb.join(","))
      return `${path}: keys [${ka}] != [${kb}]`;
    for (const k of ka) {
      const d = deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
      if (d) return d;
    }
    return null;
  }
  if (a !== b) return `${path}: ${JSON.stringify(a)?.slice(0, 80)} != ${JSON.stringify(b)?.slice(0, 80)}`;
  return null;
}

let total = 0,
  matched = 0,
  stale = 0, // line_count 不等 / 旧格式（缺 line_count）→ 源文件在索引后被改过，非移植 bug
  realMismatch = 0,
  noProduct = 0;
const failures: Array<{ file: string; diff: string }> = [];

for (const mdPath of walk(vaultDir)) {
  if (total - noProduct >= limit) break;
  total++;
  const productPath = join(resultsDir, canonicalName(vaultDir, mdPath));
  if (!existsSync(productPath)) {
    noProduct++;
    continue;
  }
  const content = readFileSync(mdPath, "utf-8");
  const docName = basename(mdPath).replace(/\.md$/, "");
  const mine = mdToTree(content, { docName, withText: true });
  const raw = JSON.parse(readFileSync(productPath, "utf-8"));
  if (raw.line_count === undefined || raw.line_count !== mine.line_count) {
    stale++;
    continue;
  }
  const product = stripSummaries(raw);
  const diff = deepEqual(product, JSON.parse(JSON.stringify(mine)));
  if (diff === null) matched++;
  else {
    realMismatch++;
    failures.push({ file: relative(vaultDir, mdPath), diff });
  }
}

console.log(
  `total md: ${total}, with product: ${matched + stale + realMismatch}, matched: ${matched}, stale(line_count drift): ${stale}, REAL mismatch: ${realMismatch}, no product: ${noProduct}`,
);
for (const f of failures.slice(0, 25)) console.log(`✗ ${f.file}\n    ${f.diff}`);
process.exit(realMismatch ? 1 : 0);
