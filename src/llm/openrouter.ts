import { canSpend, recordSpend, type SpendCategory } from "../budget/budget";

export class BudgetExceededError extends Error {
  constructor(category: string) { super(`Budget cap reached for ${category}`); this.name = "BudgetExceededError"; }
}
export class InvalidLLMOutputError extends Error {
  constructor(msg: string) { super(msg); this.name = "InvalidLLMOutputError"; }
}

type ORResponse = {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
};

async function callOnce(model: string, system: string, user: string, category: SpendCategory, estimateUsd: number) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "job-finder",
    },
    body: JSON.stringify({
      // A comma-separated list becomes an OpenRouter fallback chain: the next model is tried if one is rate-limited or down.
      ...(model.includes(",") ? { models: model.split(",").map((m) => m.trim()).filter(Boolean) } : { model }),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_object" },
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  let body: ORResponse;
  try { body = (await res.json()) as ORResponse; } catch { body = {}; }
  const u = body.usage ?? {};
  // Charge every completed call. If the provider didn't report a cost, charge the estimate so the cap still holds.
  if (res.ok || u.prompt_tokens) {
    await recordSpend({
      category, provider: "openrouter", model, usd: u.cost ?? estimateUsd,
      inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0,
    });
  }
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${body.error?.message ?? "request failed"}`);
  return body.choices?.[0]?.message?.content ?? "";
}

function parse<T>(content: string): T {
  const t = content.trim();
  try { return JSON.parse(t) as T; } catch { /* try the fallbacks below */ }
  // Models sometimes wrap JSON in a code fence and/or add commentary around it.
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()) as T; } catch { /* next */ } }
  const first = t.indexOf("{"), last = t.lastIndexOf("}");
  if (first >= 0 && last > first) return JSON.parse(t.slice(first, last + 1)) as T;
  return JSON.parse(t) as T;
}

/** One JSON-mode chat call. Checks the budget first, records cost, retries once on unparseable output. */
export async function chatJSON<T>(opts: {
  model: string; system: string; user: string; category: SpendCategory; estimateUsd: number;
}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await canSpend(opts.category, opts.estimateUsd))) throw new BudgetExceededError(opts.category);
    const content = await callOnce(opts.model, opts.system, opts.user, opts.category, opts.estimateUsd);
    try {
      return parse<T>(content);
    } catch {
      if (attempt === 1) throw new InvalidLLMOutputError(`Unparseable JSON from ${opts.model}: ${content.slice(0, 120)}`);
    }
  }
  throw new InvalidLLMOutputError("unreachable");
}
