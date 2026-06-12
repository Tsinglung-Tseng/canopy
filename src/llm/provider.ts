// Llm 后端构造：从 corpus 配置读 baseURL/apiKey/model。
// 无任何硬编码默认——三字段在 corpus 解析时已 fail-loud 校验非空。
import { OpenAICompatLlm } from "./openai.js";
import type { Llm } from "./kernel.js";
import type { CorpusConfig } from "../types/canopy.types.js";

export function makeLlm(corpus: CorpusConfig): Llm {
  return new OpenAICompatLlm({
    baseURL: corpus.llm.baseURL,
    apiKey: corpus.llm.apiKey,
    model: corpus.llm.model,
    // 文档化可选：缺省 json_schema（后端拒绝时降级 + warn）
    ...(corpus.llm.schema ? { schema: corpus.llm.schema } : {}),
  });
}
