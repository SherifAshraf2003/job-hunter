import { and, eq, isNull, desc, sql } from "drizzle-orm";
import { db } from "../db/client";
import { jobs, jobScores } from "../db/schema";
import { prefilter } from "../pipeline/prefilter";
import { loadProfile } from "../profile/load";
import { BudgetExceededError } from "../llm/openrouter";
import { makeJevScorer } from "./jev";
import type { Scorer } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pre-filters and scores every open job still in status "found".
 * Stops cleanly when the budget is reached, leaving the rest "found" for the next cycle.
 */
export async function scorePending(opts: { limit?: number; scorer?: Scorer; retryDelayMs?: number } = {}) {
  const profile = await loadProfile();
  const pending = await db.select().from(jobs)
    .where(and(eq(jobs.status, "found"), isNull(jobs.closedAt)))
    .orderBy(sql`${jobs.salaryUsdYearMid} desc nulls last`, desc(jobs.firstSeenAt))
    .limit(opts.limit ?? 100_000);

  let scored = 0, failed = 0, filtered = 0, stoppedForBudget = false, stoppedForErrors = false;
  let consecutiveErrors = 0;
  let scorer = opts.scorer;

  for (const job of pending) {
    const pf = prefilter(job);
    if (!pf.pass) {
      await db.update(jobs).set({ status: "filtered_out", statusReason: pf.reason }).where(eq(jobs.id, job.id));
      filtered++;
      continue;
    }
    scorer ??= makeJevScorer();
    let lastErr: unknown;
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      try {
        const s = await scorer.score(job, profile);
        await db.insert(jobScores).values({ jobId: job.id, engine: scorer.engine, ...s })
          .onConflictDoUpdate({ target: jobScores.jobId, set: { engine: scorer.engine, ...s, scoredAt: new Date() } });
        await db.update(jobs).set({ status: "scored", statusReason: null }).where(eq(jobs.id, job.id));
        scored++;
        consecutiveErrors = 0;
        done = true;
      } catch (e) {
        if (e instanceof BudgetExceededError) { stoppedForBudget = true; break; }
        lastErr = e;
        if (attempt === 0) await sleep(opts.retryDelayMs ?? 2000);
      }
    }
    if (stoppedForBudget) break;
    if (!done) {
      // The job stays "found" so a later cycle retries it; it only becomes score_failed after 3 cycles of failures.
      const attempts = job.scoreAttempts + 1;
      const reason = String((lastErr as Error)?.message ?? lastErr).slice(0, 300);
      await db.update(jobs).set({
        scoreAttempts: attempts, statusReason: reason,
        ...(attempts >= 3 ? { status: "score_failed" as const } : {}),
      }).where(eq(jobs.id, job.id));
      if (attempts >= 3) failed++;
      // Several failures in a row means the service or key is broken, not this job: stop and keep the backlog.
      if (++consecutiveErrors >= 3) { stoppedForErrors = true; break; }
    }
  }
  return { scored, failed, filtered, stoppedForBudget, stoppedForErrors };
}
