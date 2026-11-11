import { and, asc, eq, lt, sql } from "drizzle-orm";
import pLimit from "p-limit";
import { db } from "../db/client";
import { companies, runs } from "../db/schema";
import { fetchBoard } from "../sources/boards";
import { BoardNotFoundError } from "../sources/http";
import { fetchRemoteOk, fetchWwr, fetchHn } from "../sources/feeds";
import { upsertJobs, markClosed } from "./upsert";
import { seedCompanies, addCompanies } from "../discovery/seed";
import { scorePending } from "../scoring/scoreJobs";
import type { BoardRef, SourceResult } from "../sources/types";

export type CycleStats = {
  boards: number; boardFailures: number; inserted: number; updated: number; closed: number;
  harvested: number; seeded: number; scored: number; filtered: number; scoreFailed: number;
  stoppedForBudget: boolean; errors: string[];
};

/** Runs that have been "running" for over an hour were interrupted (sleep, crash). */
export async function abandonStaleRuns(): Promise<number> {
  const r = await db.update(runs).set({ status: "abandoned", finishedAt: new Date() })
    .where(and(eq(runs.status, "running"), lt(runs.startedAt, sql`now() - interval '1 hour'`)))
    .returning({ id: runs.id });
  return r.length;
}

export async function runSearchCycle(opts: { runId?: number } = {}): Promise<CycleStats> {
  await abandonStaleRuns();
  const runId = opts.runId ?? (await db.insert(runs).values({ status: "running", startedAt: new Date() }).returning({ id: runs.id }))[0].id;
  if (opts.runId) await db.update(runs).set({ status: "running", startedAt: new Date() }).where(eq(runs.id, runId));

  const s: CycleStats = { boards: 0, boardFailures: 0, inserted: 0, updated: 0, closed: 0, harvested: 0, seeded: 0, scored: 0, filtered: 0, scoreFailed: 0, stoppedForBudget: false, errors: [] };
  const err = (where: string, e: unknown) => s.errors.push(`${where}: ${(e as Error)?.message ?? e}`.slice(0, 300));

  try {
    try { s.seeded = (await seedCompanies()).added; } catch (e) { err("seed", e); }

    // Company boards
    const max = Number(process.env.MAX_BOARDS) || undefined;
    const boards = await db.select().from(companies).where(eq(companies.active, true))
      .orderBy(sql`${companies.lastPolledAt} asc nulls first`, asc(companies.id)).limit(max ?? 1_000_000);
    s.boards = boards.length;
    const limit = pLimit(4);
    await Promise.all(boards.map((b) => limit(async () => {
      const ref: BoardRef = { ats: b.ats, slug: b.slug };
      try {
        const list = await fetchBoard(ref);
        const u = await upsertJobs(list);
        s.inserted += u.inserted; s.updated += u.updated;
        s.closed += await markClosed(ref, list.map((j) => j.externalId));
        await db.update(companies).set({ lastPolledAt: new Date(), failCount: 0 }).where(eq(companies.id, b.id));
      } catch (e) {
        s.boardFailures++;
        err(`${b.ats}/${b.slug}`, e);
        // Only a missing board (404) counts toward deactivation; rate limits and network blips don't.
        if (e instanceof BoardNotFoundError) {
          const failCount = b.failCount + 1;
          await db.update(companies).set({ failCount, active: failCount < 3, lastPolledAt: new Date() }).where(eq(companies.id, b.id));
        }
      }
    })));

    // Feeds: each wrapped so one failure doesn't stop the others.
    const feeds: [string, () => Promise<SourceResult>][] = [["remoteok", fetchRemoteOk], ["wwr", fetchWwr]];
    if (process.env.OPENROUTER_API_KEY) feeds.push(["hn", () => fetchHn()]);
    const harvested: BoardRef[] = [];
    for (const [name, f] of feeds) {
      try {
        const r = await f();
        const u = await upsertJobs(r.jobs);
        s.inserted += u.inserted; s.updated += u.updated;
        harvested.push(...r.harvested);
      } catch (e) { err(name, e); }
    }
    s.harvested = await addCompanies(harvested.map((h) => ({ ...h, name: h.slug, origin: "harvested" as const })));

    if (process.env.TYPESAFE_API_KEY) {
      const r = await scorePending();
      s.scored = r.scored; s.filtered = r.filtered; s.scoreFailed = r.failed; s.stoppedForBudget = r.stoppedForBudget;
    } else {
      err("scoring", "TYPESAFE_API_KEY not set; scoring skipped");
    }
    await db.update(runs).set({ status: "done", finishedAt: new Date(), stats: s }).where(eq(runs.id, runId));
  } catch (e) {
    err("cycle", e);
    await db.update(runs).set({ status: "failed", finishedAt: new Date(), stats: s }).where(eq(runs.id, runId));
  }
  return s;
}
