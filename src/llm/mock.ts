// mock — 确定性、免 key 的测试后端。输出是 (prompt, seed, notes) 的纯函数，
// 同一程序永远产生同一轨迹（无 Math.random / Date）。
import type { Cost, Llm, LlmRequest, LlmResponse } from "./kernel.js";

export class MockLlm implements Llm {
  /** @param respond 脚本化行为（请求的纯函数）；缺省回显摘要。 */
  constructor(
    private readonly respond?: (req: LlmRequest) => string,
    readonly name: string = "mock",
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const text = this.respond ? this.respond(req) : defaultRespond(req);
    return { text, cost: estimateCost(req, text) };
  }

  /** 结构化输出：mock 不从 schema 捏造值——信任 respond 已返回合法 JSON；
   *  若不是 JSON 仍原样返回，让 askSchema 以 Outcome.fail 浮出解析失败。 */
  async completeSchema(req: LlmRequest): Promise<LlmResponse> {
    const text = this.respond ? this.respond(req) : defaultRespond(req);
    return { text, cost: estimateCost(req, text) };
  }
}

function defaultRespond(req: LlmRequest): string {
  const seed = req.seed ?? 0;
  return `[mock seed=${seed}] re: ${req.prompt.slice(0, 80)}`;
}

/** 粗略 token 估算：~4 chars/token，对预算机制的测试足够。 */
function estimateCost(req: LlmRequest, text: string): Cost {
  const inputChars = (req.system ?? "").length + req.prompt.length + req.notes.join("").length;
  return {
    inputTokens: Math.ceil(inputChars / 4),
    outputTokens: Math.ceil(text.length / 4),
    calls: 1,
  };
}
