import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db/client";
import { jobs, jobScores, spend, tailorings } from "../db/schema";
import { loadSettings } from "../config";
import { loadProfile } from "../profile/load";
import { canSpend, spendSummary } from "../budget/budget";
import { composite } from "../scoring/composite";
import { BudgetExceededError } from "../llm/openrouter";
import { assignTiers, pickTreatment, estimateUsd } from "./tiers";
import { generateResume, generateExtras, wantsCoverLetter } from "./generate";
import { truthCheck } from "./truth";
import { fitOnePage } from "./latex";
import { diffAgainstBase } from "./diff";
import type { Tier } from "./types";

export const OUT_DIR = path.join(process.cwd(), "data", "out");
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/**
 * Tailors every eligible job (scored, open, takeable, composite ≥ cutoff, not yet tailored), best first.
 * Checks the budget before each job; stops cleanly when it's reached, or after 3 errors in a row.
 */
export async function tailorPending(opts: {
  limit?: number;
  generator?: { resume: typeof generateResume; extras: typeof generateExtras };
} = {}) {
  const gen = opts.generator ?? { resume: generateResume, extras: generateExtras };
  const cfg = await loadSettings();
  const rows = await db.select().from(jobs)
    .innerJoin(jobScores, eq(jobScores.jobId, jobs.id))
    .leftJoin(tailorings, eq(tailorings.jobId, jobs.id))
    .where(and(eq(jobs.status, "scored"), isNull(jobs.closedAt), ne(jobScores.canTake, "not_possible"), isNull(tailorings.jobId)));
  const eligible = rows
    .map((r) => ({ job: r.jobs, composite: composite(r.job_scores, cfg.weights).score }))
    .filter((r) => r.composite >= cfg.cutoff)
    .sort((a, b) => b.composite - a.composite)
    .slice(0, opts.limit ?? 10_000);

  const [{ n: topToday }] = await db.select({ n: sql<number>`count(*)::int` }).from(tailorings)
    .where(and(eq(tailorings.tier, "top"), gte(tailorings.createdAt, startOfToday())));
  const tiers = assignTiers(eligible.map((e) => ({ id: e.job.id, composite: e.composite })), cfg, topToday);

  const result = { tailored: 0, failed: 0, stoppedForBudget: false, stoppedForErrors: false, byTier: { top: 0, middle: 0, bottom: 0 } as Record<Tier, number> };
  if (!eligible.length) return result;
  const profile = await loadProfile();
  const baseTex = readFileSync(path.join(process.cwd(), "resume.tex"), "utf8");
  let consecutiveErrors = 0;

  for (const { job } of eligible) {
    const tier = tiers.get(job.id)!;
    const { monthUsd, capUsd } = await spendSummary();
    const t = pickTreatment(tier, monthUsd / capUsd);
    if (!(await canSpend("tailoring", estimateUsd(t)))) { result.stoppedForBudget = true; break; }
    const started = new Date();
    const usdSince = async () => {
      const [r] = await db.select({ s: sql<number>`coalesce(sum(${spend.usd}), 0)` }).from(spend).where(gte(spend.at, started));
      return Number(r.s);
    };
    try {
      const draft = await gen.resume(job, profile, t);
      const checked = await truthCheck(draft, profile, t.extrasModel);
      const outDir = path.join(OUT_DIR, String(job.id));
      let pdfPath: string | null = null, error: string | null = null, final = checked.resume;
      try {
        const fit = await fitOnePage(checked.resume, profile, baseTex, outDir);
        pdfPath = fit.pdfPath; final = fit.resume;
      } catch (e) { error = (e as Error).message; }
      const extras = await gen.extras(job, profile, t, wantsCoverLetter(job));
      await db.insert(tailorings).values({
        jobId: job.id, tier, model: t.resumeModel ?? "base", resume: final, issues: checked.issues,
        diff: diffAgainstBase(final, profile), coverLetter: extras.coverLetter, gapReport: extras.gapReport, prep: extras.prep,
        pdfPath, error, usd: await usdSince(),
      });
      if (error) { result.failed++; consecutiveErrors++; } else { result.tailored++; result.byTier[tier]++; consecutiveErrors = 0; }
    } catch (e) {
      if (e instanceof BudgetExceededError) { result.stoppedForBudget = true; break; }
      result.failed++; consecutiveErrors++;
      await db.insert(tailorings).values({ jobId: job.id, tier, model: t.resumeModel ?? "base", error: (e as Error).message.slice(0, 300), usd: await usdSince() })
        .onConflictDoNothing();
    }
    if (consecutiveErrors >= 3) { result.stoppedForErrors = true; break; }
  }
  return result;
}
