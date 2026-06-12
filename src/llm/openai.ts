// openai — 零依赖 OpenAI-compatible LLM 后端（全局 fetch，无 SDK）。
// 覆盖 OpenAI 本体 / DeepSeek / SiliconFlow / Ollama / vLLM 等一切兼容端点。
// 三轴参数化：baseURL / model / apiKey，全部必填无默认（缺失即配置错，fail loud）。
//
// 结构化输出（completeSchema）按 schema 模式发 response_format：
//   - "json_schema"（默认）：严格模式，OpenAI / 新版兼容端支持
//   - "json_object"：schema 仅进 prompt hint，兼容面更广（DeepSeek 只认这个）
//   - "off"：不暴露 completeSchema → askSchema 走原语级降级（prompt hint）
import type { Llm, LlmRequest, LlmResponse } from "./kernel.js";
import { getLogger } from "../logging.js";

const log = getLogger("llm");

export interface OpenAICompatOpts {
  /** OpenAI 兼容端点基址，如 https://api.deepseek.com/v1。必填，无默认。 */
  baseURL: string;
  /** 模型 id。必填，无默认。 */
  model: string;
  /** API key。必填，无默认（corpus 解析层已 fail-loud 校验来源）。 */
  apiKey: string;
  defaultMaxTokens?: number;
  schema?: "json_schema" | "json_object" | "off";
}

export class OpenAICompatLlm implements Llm {
  private readonly model: string;
  private readonly baseURL: string;
  private readonly defaultMaxTokens: number;
  private readonly apiKey: string;
  private readonly schemaMode: "json_schema" | "json_object" | "off";

  constructor(opts: OpenAICompatOpts) {
    if (!opts.baseURL) throw new Error("OpenAICompatLlm: baseURL 必填（无默认，缺失即配置错）。");
    if (!opts.model) throw new Error("OpenAICompatLlm: model 必填（无默认，缺失即配置错）。");
    if (!opts.apiKey) throw new Error("OpenAICompatLlm: apiKey 必填（无默认，缺失即配置错）。");
    this.baseURL = opts.baseURL.replace(/\/+$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 1024;
    this.schemaMode = opts.schema ?? "json_schema";

    // schemaMode="off" → 不暴露 completeSchema（askSchema feature-detect
    // `!!llm.completeSchema` 据此走原语级降级）。completeSchema 是原型方法，
    // 须以「自有 undefined 属性」遮蔽，delete 删不掉原型方法。
    if (this.schemaMode === "off") {
      Object.defineProperty(this, "completeSchema", { value: undefined, enumerable: false });
    }
  }

  get name(): string {
    return this.model;
  }

  private buildMessages(req: LlmRequest): Array<{ role: string; content: string }> {
    const systemBlock = [req.system, ...req.notes].filter(Boolean).join("\n\n");
    const messages: Array<{ role: string; content: string }> = [];
    if (systemBlock) messages.push({ role: "system", content: systemBlock });
    messages.push({ role: "user", content: req.prompt });
    return messages;
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  }

  private parse(json: OpenAIChatResponse): LlmResponse {
    const choice = json.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== "string") {
      throw new Error(
        `OpenAICompatLlm: malformed response (no choices[0].message.content) — ${JSON.stringify(json)}`,
      );
    }
    const usage = json.usage;
    if (
      usage == null ||
      typeof usage.prompt_tokens !== "number" ||
      typeof usage.completion_tokens !== "number"
    ) {
      throw new Error(
        `OpenAICompatLlm: malformed response (missing usage tokens) — ${JSON.stringify(json)}`,
      );
    }
    return {
      text,
      cost: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, calls: 1 },
    };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.buildMessages(req),
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
    };
    if (req.seed != null) body.seed = req.seed;

    const res = await this.post(body);
    if (!res.ok) {
      const errBody = await res.text().catch(() => "<unreadable body>");
      throw new Error(
        `OpenAICompatLlm: ${res.status} ${res.statusText} from ${this.baseURL}/chat/completions — ${errBody}`,
      );
    }
    return this.parse((await res.json()) as OpenAIChatResponse);
  }

  /** 结构化输出。后端拒绝 response_format 时降级到 complete + schema hint 并记
   *  warn（log 不静默）；其它非 2xx fail loud。 */
  async completeSchema(req: LlmRequest): Promise<LlmResponse> {
    if (!req.responseSchema) {
      throw new Error("OpenAICompatLlm.completeSchema: req.responseSchema is required.");
    }
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.buildMessages(req),
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
    };
    if (req.seed != null) body.seed = req.seed;
    body.response_format =
      this.schemaMode === "json_schema"
        ? { type: "json_schema", json_schema: { name: "output", schema: req.responseSchema, strict: true } }
        : { type: "json_object" };

    const res = await this.post(body);
    if (res.ok) {
      return this.parse((await res.json()) as OpenAIChatResponse);
    }

    const errBody = await res.text().catch(() => "<unreadable body>");
    // 仅当报错指向 response_format 不支持时降级（记 warn）；其它错误 fail loud。
    if (res.status === 400 && /response_format|json_schema|json_object/i.test(errBody)) {
      log.warn(
        `completeSchema: 后端不支持 response_format（${res.status}）——降级到 complete + prompt hint。body: ${errBody.slice(0, 200)}`,
      );
      const hint = `${req.prompt}\n\n只输出符合此 JSON Schema 的合法 JSON：\n${JSON.stringify(req.responseSchema)}`;
      return this.complete({ ...req, prompt: hint });
    }
    throw new Error(
      `OpenAICompatLlm.completeSchema: ${res.status} ${res.statusText} from ${this.baseURL}/chat/completions — ${errBody}`,
    );
  }
}

/** OpenAI 兼容响应里我们读的切片。 */
interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
