// kernel — Canopy 自带的最小 LLM 编排内核（ADR-008）。
//
// 这是 Plexus 七原语中 Canopy 实际消费的子集（ask/askSchema/par/Budget/run）的
// 零依赖内联实现，接口签名与 Plexus 保持结构兼容：任何实现了 `Llm`（complete 必备、
// completeSchema 可选）的对象都能注入——包括 Plexus 的 OpenAICompatLlm/DeepSeekLlm/
// AnthropicLlm 实例（TS 结构类型，无需 import plexus）。本机开发要 Plexus 的
// recorder/eventstore/coordinate 能力时，在调用侧构造 Plexus 后端传入即可。
//
// 不内联的 Plexus 面（Canopy 不消费）：streaming、tool-use、recorder/eventstore、
// coordinate cube、sub-budget、workflow/memory/journal/trace。

/* ── 代数：Cost（Writer 通道）与 Outcome（失败+值+成本） ───────────────── */

export interface Cost {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 折入此成本的叶级 LLM 调用次数。 */
  readonly calls: number;
}

export const ZERO_COST: Cost = { inputTokens: 0, outputTokens: 0, calls: 0 };

export function addCost(a: Cost, b: Cost): Cost {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    calls: a.calls + b.calls,
  };
}

/** 每个 Outcome 都带成本——失败的 agent 也烧了 token，预算必须看见。 */
export type Outcome<A> =
  | { readonly ok: true; readonly value: A; readonly cost: Cost }
  | { readonly ok: false; readonly reason: string; readonly cost: Cost };

export function ok<A>(value: A, cost: Cost = ZERO_COST): Outcome<A> {
  return { ok: true, value, cost };
}

export function fail<A = never>(reason: string, cost: Cost = ZERO_COST): Outcome<A> {
  return { ok: false, reason, cost };
}

/* ── Llm seam：complete 必备，completeSchema 可选（feature-detect） ─────── */

export interface LlmRequest {
  readonly system?: string;
  readonly prompt: string;
  /** 线程化的上下文备注（Canopy 现行恒为空数组，保留以兼容 Plexus 后端签名）。 */
  readonly notes: ReadonlyArray<string>;
  readonly maxTokens?: number;
  readonly seed?: number;
  /** 结构化输出 schema，completeSchema 读取；plain complete 忽略。 */
  readonly responseSchema?: object;
}

export interface LlmResponse {
  readonly text: string;
  readonly cost: Cost;
}

export interface Llm {
  readonly name?: string;
  /** 一次叶级推理。返回文本 + 实际成本。 */
  complete(req: LlmRequest): Promise<LlmResponse>;
  /** 可选：后端原生结构化输出。缺失时 askSchema 降级为 complete + schema hint。 */
  completeSchema?(req: LlmRequest): Promise<LlmResponse>;
}

/* ── Budget：token 花费 = 一等公民，见底 throw（fail loud 无静默降级） ──── */

export class Budget {
  private _spent: Cost = ZERO_COST;

  /** total === null 表示无上限。 */
  constructor(public readonly total: number | null = null) {}

  /** 整个 run 至今花掉的 output tokens。 */
  spent(): number {
    return this._spent.outputTokens;
  }

  fullCost(): Cost {
    return this._spent;
  }

  remaining(): number {
    if (this.total === null) return Infinity;
    return Math.max(0, this.total - this.spent());
  }

  charge(cost: Cost): void {
    this._spent = addCost(this._spent, cost);
  }

  assertAffordable(): void {
    if (this.total !== null && this.remaining() <= 0) {
      throw new BudgetExhausted(this.total, this.spent());
    }
  }
}

export class BudgetExhausted extends Error {
  constructor(total: number, spent: number) {
    super(`Canopy budget exhausted: ${spent}/${total} output tokens spent`);
    this.name = "BudgetExhausted";
  }
}

/* ── Ctx 与 Agent：agent 是 Kleisli 箭头 Ctx -> Promise<Outcome<A>> ─────── */

export interface Ctx {
  readonly notes: ReadonlyArray<string>;
  /** 共享 token 池——par 派生的所有子 agent 都从这一个池扣。 */
  readonly budget: Budget;
  readonly llm: Llm;
}

export type Agent<A> = (ctx: Ctx) => Promise<Outcome<A>>;

export function makeCtx(llm: Llm, budget: Budget = new Budget(null), notes: string[] = []): Ctx {
  return { llm, budget, notes };
}

/* ── 原语：ask（原子）/ askSchema（结构化）/ par（应用式并发） ──────────── */

/** 一次 LLM 推理。预算见底 THROW（结构性不能继续）；语义失败返回 Outcome.fail。 */
export function ask(prompt: string, opts: { system?: string; maxTokens?: number; seed?: number } = {}): Agent<string> {
  return async (ctx: Ctx): Promise<Outcome<string>> => {
    ctx.budget.assertAffordable();
    const res = await ctx.llm.complete({
      prompt,
      system: opts.system,
      notes: ctx.notes,
      maxTokens: opts.maxTokens,
      seed: opts.seed,
    });
    ctx.budget.charge(res.cost);
    return ok(res.text, res.cost);
  };
}

export interface SchemaOpts {
  system?: string;
  maxTokens?: number;
  seed?: number;
  /** 把解析后的 JSON 提炼成 T，throw 即拒绝（→ Outcome.fail，可恢复）。 */
  validate?: (raw: unknown) => unknown;
}

/** 结构化输出：后端有 completeSchema 走原生强制；否则 complete + schema hint 降级。
 *  解析/校验失败是可恢复的语义失败 → Outcome.fail，绝不 throw。 */
export function askSchema<T>(prompt: string, schema: object, opts: SchemaOpts = {}): Agent<T> {
  return async (ctx: Ctx): Promise<Outcome<T>> => {
    ctx.budget.assertAffordable();
    const hasNative = !!ctx.llm.completeSchema;
    const effectivePrompt = hasNative
      ? prompt
      : `${prompt}\n\nReturn ONLY valid JSON conforming to this JSON Schema:\n${JSON.stringify(schema)}`;
    const req: LlmRequest = {
      prompt: effectivePrompt,
      system: opts.system,
      notes: ctx.notes,
      maxTokens: opts.maxTokens,
      seed: opts.seed,
      responseSchema: schema,
    };
    const res = hasNative ? await ctx.llm.completeSchema!(req) : await ctx.llm.complete(req);
    ctx.budget.charge(res.cost);

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch (e) {
      return fail(`askSchema: response was not valid JSON: ${(e as Error).message}`, res.cost);
    }
    try {
      const validated = opts.validate ? opts.validate(parsed) : parsed;
      return ok(validated as T, res.cost);
    } catch (e) {
      return fail(`askSchema validation failed: ${(e as Error).message}`, res.cost);
    }
  };
}

/** 应用式并发 barrier。返回 Outcome[]——失败不静默丢弃，由调用方裁决。 */
export function par<A>(agents: Array<Agent<A>>): Agent<Array<Outcome<A>>> {
  return async (ctx: Ctx): Promise<Outcome<Array<Outcome<A>>>> => {
    const results = await Promise.all(agents.map((a) => a(ctx)));
    const cost = results.reduce((c, r) => addCost(c, r.cost), ZERO_COST);
    return ok(results, cost);
  };
}

/* ── run：边界解释器——建 Ctx、跑顶层 agent、交出 Outcome + 总账 ─────────── */

export interface RunOpts {
  budget?: number | null;
  notes?: string[];
}

export interface RunResult<A> {
  outcome: Outcome<A>;
  spent: Cost;
}

export async function run<A>(agent: Agent<A>, llm: Llm, opts: RunOpts = {}): Promise<RunResult<A>> {
  const budget = new Budget(opts.budget ?? null);
  const ctx = makeCtx(llm, budget, opts.notes ?? []);
  const outcome = await agent(ctx);
  return { outcome, spent: budget.fullCost() };
}
