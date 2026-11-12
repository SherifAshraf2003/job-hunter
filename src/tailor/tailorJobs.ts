import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, gte, isNull, lt, ne, or, sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
    // Not tailored yet, or a failed attempt without a PDF that hasn't failed 3 times.
    .where(and(eq(jobs.status, "scored"), isNull(jobs.closedAt), ne(jobScores.canTake, "not_possible"),
      or(isNull(tailorings.jobId), and(isNull(tailorings.pdfPath), lt(tailorings.attempts, 3)))));
  const eligible = rows
    .map((r) => ({ job: r.jobs, composite: composite(r.job_scores, cfg.weights).score, attempts: r.tailorings?.attempts ?? 0 }))
    .filter((r) => r.composite >= cfg.cutoff)
    .sort((a, b) => b.composite - a.composite)
    .slice(0, opts.limit ?? 10_000);

  const [{ n: topToday }] = await db.select({ n: sql<number>`count(*)::int` }).from(tailorings)
    .where(and(eq(tailorings.tier, "top"), gte(tailorings.createdAt, startOfToday()), sql`${tailorings.pdfPath} is not null`));
  const tiers = assignTiers(eligible.map((e) => ({ id: e.job.id, composite: e.composite })), cfg, topToday);

  const result = { tailored: 0, failed: 0, stoppedForBudget: false, stoppedForErrors: false, missingTectonic: false, byTier: { top: 0, middle: 0, bottom: 0 } as Record<Tier, number> };
  if (!eligible.length) return result;
  // Without a LaTeX engine every job would pay for model calls and then fail; check once, before spending anything.
  if (!opts.generator) {
    try { await promisify(execFile)("tectonic", ["--version"]); } catch { result.missingTectonic = true; return result; }
  }
  const profile = await loadProfile();
  const baseTex = readFileSync(path.join(process.cwd(), "resume.tex"), "utf8");
  let consecutiveErrors = 0;

  for (const { job, attempts } of eligible) {
    const tier = tiers.get(job.id)!;
    const { monthUsd, capUsd } = await spendSummary();
    const t = pickTreatment(tier, monthUsd / capUsd);
    if (!(await canSpend("tailoring", estimateUsd(t)))) { result.stoppedForBudget = true; break; }
    const started = new Date();
    const usdSince = async () => {
      const [r] = await db.select({ s: sql<number>`coalesce(sum(${spend.usd}), 0)` }).from(spend).where(gte(spend.at, started));
      return Number(r.s);
    };
    const save = async (v: Partial<typeof tailorings.$inferInsert>) => {
      const row = { jobId: job.id, tier, model: t.resumeModel ?? "base", attempts: attempts + 1, usd: await usdSince(), ...v };
      await db.insert(tailorings).values(row).onConflictDoUpdate({ target: tailorings.jobId, set: { ...row, createdAt: new Date() } });
    };
    try {
      const draft = await gen.resume(job, profile, t);
      const checked = await truthCheck(draft, profile, t.extrasModel, undefined, job.descriptionText);
      // Build the PDF before paying for the cover letter, so a LaTeX failure doesn't cost that call.
      let fit: { resume: typeof checked.resume; pdfPath: string };
      try {
        fit = await fitOnePage(checked.resume, profile, baseTex, path.join(OUT_DIR, String(job.id)));
      } catch (e) {
        await save({ resume: checked.resume, issues: checked.issues, error: (e as Error).message, pdfPath: null });
        result.failed++; consecutiveErrors++;
        if (consecutiveErrors >= 3) { result.stoppedForErrors = true; break; }
        continue;
      }
      const extras = await gen.extras(job, profile, t, { coverLetter: wantsCoverLetter(job), insights: false });
      await save({
        resume: fit.resume, issues: checked.issues, diff: diffAgainstBase(fit.resume, profile),
        coverLetter: extras.coverLetter, pdfPath: fit.pdfPath, error: null,
      });
      result.tailored++; result.byTier[tier]++; consecutiveErrors = 0;
    } catch (e) {
      if (e instanceof BudgetExceededError) { result.stoppedForBudget = true; break; }
      result.failed++; consecutiveErrors++;
      await save({ error: (e as Error).message.slice(0, 300), pdfPath: null });
    }
    if (consecutiveErrors >= 3) { result.stoppedForErrors = true; break; }
  }
  return result;
}
