import { and, eq, inArray, isNull, isNotNull, sql, desc, type SQL } from "drizzle-orm";
import { db } from "../db/client";
import { jobs, jobScores, jobSources, runs } from "../db/schema";
import { composite } from "../scoring/composite";
import type { Weights } from "../config";

export type JobFilters = {
  stage?: "found" | "scored" | "filtered_out" | "score_failed";
  canTake?: boolean; salaryPosted?: boolean; minScore?: number;
  ai?: boolean; founding?: boolean; remote?: boolean; source?: string; includeClosed?: boolean;
};

export type RankedJob = typeof jobs.$inferSelect & {
  scores: typeof jobScores.$inferSelect | null;
  composite: number | null;
  sortGroup: 0 | 1;
  sources: { source: string; url: string }[];
};

const AI_RE = "\\m(ai|ml|llm|machine learning)\\M";

function where(f: JobFilters): SQL | undefined {
  const c: SQL[] = [];
  if (!f.includeClosed) c.push(isNull(jobs.closedAt));
  c.push(eq(jobs.status, f.stage ?? "scored"));
  if (f.salaryPosted) c.push(isNotNull(jobs.salaryMin));
  if (f.remote) c.push(eq(jobs.remotePolicy, "remote"));
  if (f.founding) c.push(sql`${jobs.title} ~* 'founding'`);
  if (f.ai) c.push(sql`(${jobs.title} ~* ${AI_RE} or ${jobs.descriptionText} ~* ${AI_RE})`);
  if (f.canTake) c.push(sql`(${jobScores.canTake} is null or ${jobScores.canTake} <> 'not_possible')`);
  if (f.source) c.push(sql`exists (select 1 from job_sources s where s.job_id = ${jobs.id} and s.source = ${f.source})`);
  return and(...c);
}

async function attachSources(rows: { id: number }[]) {
  const ids = rows.map((r) => r.id);
  const map = new Map<number, { source: string; url: string }[]>();
  if (!ids.length) return map;
  const src = await db.select({ jobId: jobSources.jobId, source: jobSources.source, url: jobSources.url }).from(jobSources).where(inArray(jobSources.jobId, ids));
  for (const s of src) map.set(s.jobId, [...(map.get(s.jobId) ?? []), { source: s.source, url: s.url }]);
  return map;
}

function rank(rows: { jobs: typeof jobs.$inferSelect; job_scores: typeof jobScores.$inferSelect | null }[], w: Weights, srcs: Map<number, { source: string; url: string }[]>): RankedJob[] {
  return rows.map(({ jobs: j, job_scores: s }) => {
    const c = s ? composite(s, w) : null;
    return { ...j, scores: s, composite: c?.score ?? null, sortGroup: c?.sortGroup ?? 0, sources: srcs.get(j.id) ?? [] };
  });
}

export async function listJobs(f: JobFilters, w: Weights, limit = 300): Promise<RankedJob[]> {
  const rows = await db.select().from(jobs).leftJoin(jobScores, eq(jobScores.jobId, jobs.id)).where(where(f))
    .orderBy(desc(jobs.firstSeenAt));
  const ranked = rank(rows, w, new Map())
    .filter((r) => f.minScore == null || (r.composite ?? 0) >= f.minScore)
    .sort((a, b) => a.sortGroup - b.sortGroup || (b.composite ?? -1) - (a.composite ?? -1) || +b.firstSeenAt - +a.firstSeenAt)
    .slice(0, limit);
  const srcs = await attachSources(ranked);
  return ranked.map((r) => ({ ...r, sources: srcs.get(r.id) ?? [] }));
}

export async function getJob(id: number, w: Weights): Promise<RankedJob | null> {
  const rows = await db.select().from(jobs).leftJoin(jobScores, eq(jobScores.jobId, jobs.id)).where(eq(jobs.id, id));
  if (!rows.length) return null;
  return rank(rows, w, await attachSources([{ id }]))[0];
}

export async function stageCounts() {
  const rows = await db.select({ status: jobs.status, n: sql<number>`count(*)::int` }).from(jobs).where(isNull(jobs.closedAt)).groupBy(jobs.status);
  const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  return { found: get("found"), scored: get("scored"), filteredOut: get("filtered_out"), failed: get("score_failed") };
}

export async function latestRun() {
  const [r] = await db.select().from(runs).where(isNotNull(runs.status)).orderBy(desc(runs.id)).limit(1);
  return r ?? null;
}

export async function sourceCount(): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(distinct source)::int` }).from(jobSources);
  return r?.n ?? 0;
}
