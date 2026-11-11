import { test, expect, beforeEach, afterAll } from "vitest";
import { db, resetDb, closeDb } from "@/db/client";
import { jobs, profile } from "@/db/schema";
import { scorePending } from "@/scoring/scoreJobs";
import { BudgetExceededError } from "@/llm/openrouter";
import type { Scorer, DimensionScores } from "@/scoring/types";
import { parseResumeFile } from "@/profile/load";

beforeEach(async () => {
  await resetDb();
  await db.insert(profile).values({ id: 1, data: parseResumeFile() });
  for (let i = 1; i <= 5; i++) {
    await db.insert(jobs).values({ key: `co${i}|ai engineer`, title: "AI Engineer", companyName: `Co${i}`, applyUrl: "https://x", descriptionText: "Build LLM features." });
  }
});
afterAll(async () => { await closeDb(); });

test("stops scoring when budget would be exceeded", async () => {
  let calls = 0;
  const fake: Scorer = {
    engine: "jev",
    estimateUsd: () => 0.0003,
    async score(): Promise<DimensionScores> {
      calls++;
      if (calls === 3) throw new BudgetExceededError("scoring");
      return { scope: 80, company: 60, pay: 50, level: 70, fit: 90, canTake: "remote_from_egypt", canTakeConfidence: 0.8, raw: {} };
    },
  };
  const r = await scorePending({ scorer: fake });
  expect(r.scored).toBe(2);
  expect(r.stoppedForBudget).toBe(true);
  const rows = await db.select().from(jobs);
  expect(rows.filter((j) => j.status === "scored")).toHaveLength(2);
  expect(rows.filter((j) => j.status === "found")).toHaveLength(3);
});
