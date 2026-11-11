import { test, expect, beforeEach, afterAll, vi } from "vitest";
import { db, resetDb, closeDb } from "@/db/client";
import { jobs, spend } from "@/db/schema";
import { chatJSON } from "@/llm/openrouter";
import { makeJevScorer } from "@/scoring/jev";
import { parseResumeFile } from "@/profile/load";

beforeEach(async () => { await resetDb(); vi.restoreAllMocks(); });
afterAll(async () => { await closeDb(); });

test("openrouter call without a reported cost is charged at its estimate, not $0", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: '{"ok":true}' } }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  }), { status: 200 }));
  await chatJSON({ model: "m", system: "s", user: "u", category: "scoring", estimateUsd: 0.002 });
  const rows = await db.select().from(spend);
  expect(rows).toHaveLength(1);
  expect(rows[0].usd).toBeCloseTo(0.002, 6);
});

test("jev call without reported usage is charged at its estimate, not $0", async () => {
  process.env.TYPESAFE_API_KEY ||= "test-key";
  const answers = {
    scope: { score: 3 }, company: { score: 2 }, pay: { score: 1 }, level: { score: 3 }, fit: { score: 4 },
    canTake: { choice: "remote_from_egypt", confidence: 0.9 },
  };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    model: "jev-test", answers, usage: { input_tokens: null, output_tokens: null },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const [job] = await db.insert(jobs).values({ key: "a|b", title: "AI Engineer", companyName: "A", applyUrl: "https://x" }).returning();
  const scorer = makeJevScorer();
  await scorer.score(job, parseResumeFile());
  const rows = await db.select().from(spend);
  expect(rows).toHaveLength(1);
  expect(rows[0].usd).toBeCloseTo(scorer.estimateUsd(), 6);
});
