import { test, expect, beforeEach, afterAll, describe } from "vitest";
import { db, resetDb, closeDb } from "@/db/client";
import { jobs, jobScores, profile, spend, tailorings } from "@/db/schema";
import { assignTiers, pickTreatment, TOP_MODEL, MID_MODEL } from "@/tailor/tiers";
import { tailorPending } from "@/tailor/tailorJobs";
import { config } from "@/config";
import { parseResumeFile } from "@/profile/load";

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

describe("pickTreatment", () => {
  test("every tier gets a full rewrite at normal spend", () => {
    for (const tier of ["top", "middle", "bottom"] as const) expect(pickTreatment(tier, 0.75).rewrite).toBe("full");
    expect(pickTreatment("top", 0.5).resumeModel).toBe(TOP_MODEL);
  });
  test("at 90%+ of the month's budget it falls back to a light rewrite", () => {
    const t = pickTreatment("top", 0.95);
    expect(t.rewrite).toBe("reorder");
    expect(t.resumeModel).toBe(MID_MODEL);
  });
});

test("assignTiers respects the daily top-tier limit", () => {
  const comps = [95, 90, 85, 82, 81, 80, 75, 65];
  const m = assignTiers(comps.map((c, i) => ({ id: i + 1, composite: c })), config, 2);
  const tierOf = (c: number) => m.get(comps.indexOf(c) + 1);
  expect([95, 90, 85].map(tierOf)).toEqual(["top", "top", "top"]);
  expect([82, 81, 80, 75].map(tierOf)).toEqual(["middle", "middle", "middle", "middle"]);
  expect(tierOf(65)).toBe("bottom");
});

test("tailorPending stops when budget would be exceeded", async () => {
  await db.insert(profile).values({ id: 1, data: parseResumeFile() });
  const [j] = await db.insert(jobs).values({ key: "a|ai engineer", title: "AI Engineer", companyName: "A", applyUrl: "https://x", status: "scored" }).returning();
  await db.insert(jobScores).values({ jobId: j.id, engine: "jev", scope: 90, company: 90, pay: 90, level: 90, fit: 90, canTake: "remote_from_egypt", canTakeConfidence: 0.9 });
  await db.insert(spend).values({ category: "tailoring", provider: "openrouter", model: "m", usd: 9.995 }); // leaves $0.005, less than the cheapest treatment ($0.008)
  let called = 0;
  const fake = {
    resume: async () => { called++; throw new Error("should not be called"); },
    extras: async () => { called++; throw new Error("should not be called"); },
  };
  const r = await tailorPending({ generator: fake as never });
  expect(r.stoppedForBudget).toBe(true);
  expect(r.tailored).toBe(0);
  expect(called).toBe(0);
  expect(await db.select().from(tailorings)).toHaveLength(0);
});

test("tailorPending with jobIds tailors only those jobs, even below the cutoff", async () => {
  await db.insert(profile).values({ id: 1, data: parseResumeFile() });
  const mk = async (key: string, s: number) => {
    const [j] = await db.insert(jobs).values({ key, title: "Engineer", companyName: key, applyUrl: "https://x", status: "scored" }).returning();
    await db.insert(jobScores).values({ jobId: j.id, engine: "jev", scope: s, company: s, pay: s, level: s, fit: s, canTake: "remote_from_egypt", canTakeConfidence: 0.9 });
    return j.id;
  };
  const low = await mk("low", 30);
  await mk("high", 90);
  const seen: number[] = [];
  const fake = {
    resume: async (job: { id: number }) => { seen.push(job.id); throw new Error("stop here"); },
    extras: async () => { throw new Error("unused"); },
  };
  await tailorPending({ generator: fake as never, jobIds: [low] });
  expect(seen).toEqual([low]);
});
