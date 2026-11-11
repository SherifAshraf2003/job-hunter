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
export async function scorePending(opts: { limit?: number; scorer?: Scorer } = {}) {
  const profile = await loadProfile();
  const pending = await db.select().from(jobs)
    .where(and(eq(jobs.status, "found"), isNull(jobs.closedAt)))
    .orderBy(sql`${jobs.salaryUsdYearMid} desc nulls last`, desc(jobs.firstSeenAt))
    .limit(opts.limit ?? 100_000);

  let scored = 0, failed = 0, filtered = 0, stoppedForBudget = false;
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
        done = true;
      } catch (e) {
        if (e instanceof BudgetExceededError) { stoppedForBudget = true; break; }
        lastErr = e;
        if (attempt === 0) await sleep(2000);
      }
    }
    if (stoppedForBudget) break;
    if (!done) {
      failed++;
      await db.update(jobs).set({ status: "score_failed", statusReason: String((lastErr as Error)?.message ?? lastErr).slice(0, 300) })
        .where(eq(jobs.id, job.id));
    }
  }
  return { scored, failed, filtered, stoppedForBudget };
}
