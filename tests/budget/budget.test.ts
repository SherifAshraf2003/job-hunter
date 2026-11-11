import { describe, test, expect, beforeEach, afterAll, vi } from "vitest";
import { db, resetDb, closeDb } from "@/db/client";
import { spend } from "@/db/schema";
import { canSpend, recordSpend } from "@/budget/budget";
import { chatJSON, BudgetExceededError } from "@/llm/openrouter";

const NOW = new Date(2026, 10, 15, 12, 0, 0); // 15 Nov 2026 local
const earlierThisMonth = new Date(2026, 10, 3, 9, 0, 0);
const lastMonth = new Date(2026, 9, 20, 9, 0, 0);

async function add(category: "scoring" | "tailoring", usd: number, at: Date) {
  await db.insert(spend).values({ category, provider: "openrouter", model: "m", usd, at });
}

beforeEach(async () => { await resetDb(); vi.restoreAllMocks(); });
afterAll(async () => { await closeDb(); });

describe("budget caps", () => {
  test("scoring share of the month ($5) is enforced, tailoring is not blocked by it", async () => {
    await add("scoring", 4.99, earlierThisMonth);
    expect(await canSpend("scoring", 0.02, NOW)).toBe(false);
    expect(await canSpend("tailoring", 0.02, NOW)).toBe(true);
  });

  test("daily scoring cap is scoring share / 30", async () => {
    await add("scoring", 0.16, NOW);
    expect(await canSpend("scoring", 0.01, NOW)).toBe(false);
    expect(await canSpend("scoring", 0.005, NOW)).toBe(true);
  });

  test("monthly total cap of $10 applies to everything", async () => {
    await add("tailoring", 9.99, earlierThisMonth);
    expect(await canSpend("tailoring", 0.02, NOW)).toBe(false);
  });

  test("last month's spend is ignored", async () => {
    await add("tailoring", 9.99, lastMonth);
    await add("scoring", 4.99, lastMonth);
    expect(await canSpend("tailoring", 0.02, NOW)).toBe(true);
    expect(await canSpend("scoring", 0.02, NOW)).toBe(true);
  });

  test("recordSpend stores a row that later counts against the cap", async () => {
    await recordSpend({ category: "tailoring", provider: "openrouter", model: "m", usd: 10, inputTokens: 1, outputTokens: 1 });
    expect(await canSpend("tailoring", 0.001)).toBe(false);
  });
});

describe("chatJSON respects the budget", () => {
  test("throws BudgetExceededError without calling fetch when over budget", async () => {
    await add("scoring", 5, new Date());
    const f = vi.spyOn(globalThis, "fetch");
    await expect(chatJSON({ model: "m", system: "s", user: "u", category: "scoring", estimateUsd: 0.001 }))
      .rejects.toBeInstanceOf(BudgetExceededError);
    expect(f).not.toHaveBeenCalled();
  });

  test("records the provider-reported cost after a successful call", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.00042 },
    }), { status: 200 }));
    const out = await chatJSON<{ ok: boolean }>({ model: "m", system: "s", user: "u", category: "scoring", estimateUsd: 0.001 });
    expect(out).toEqual({ ok: true });
    const rows = await db.select().from(spend);
    expect(rows).toHaveLength(1);
    expect(rows[0].usd).toBeCloseTo(0.00042, 6);
    expect(rows[0].inputTokens).toBe(100);
  });
});
