import { and, eq, gte, inArray, isNull, isNotNull, or, sql, desc, type SQL } from "drizzle-orm";
import { db } from "../db/client";
import { applications, jobs, jobScores, jobSources, runs, tailorings } from "../db/schema";
import { composite, TOO_SENIOR_LEVEL } from "../scoring/composite";
import type { Weights } from "../config";

export type JobFilters = {
  stage?: "found" | "scored" | "tailored" | "filtered_out" | "score_failed" | AppStage;
  canTake?: boolean; salaryPosted?: boolean; minScore?: number;
  ai?: boolean; founding?: boolean; remote?: boolean; source?: string; includeClosed?: boolean;
  /** Only jobs with no application yet: the "Jobs to look at" tab. */
  fresh?: boolean;
};

/** Pipeline stages backed by the applications table, and the statuses each one shows. */
export const APP_STAGES = {
  ready: ["ready_to_submit"], needs_you: ["needs_you"], applied: ["applied", "rejected", "offer"],
  interviewing: ["interviewing"], manual: ["manual"],
} as const;
export type AppStage = keyof typeof APP_STAGES;

export type RankedJob = typeof jobs.$inferSelect & {
  scores: typeof jobScores.$inferSelect | null;
  composite: number | null;
  sortGroup: 0 | 1;
  sources: { source: string; url: string }[];
};

const AI_RE = "\\m(ai|ml|llm|machine learning)\\M";

function where(f: JobFilters): SQL | undefined {
  const c: SQL[] = [];
  // Applied and interviewing jobs stay listed after the posting closes.
  const keepClosed = f.includeClosed || f.stage === "applied" || f.stage === "interviewing";
  if (!keepClosed) c.push(isNull(jobs.closedAt));
  if (f.stage && f.stage in APP_STAGES) {
    const st = APP_STAGES[f.stage as AppStage].map((x) => `'${x}'`).join(",");
    c.push(sql`exists (select 1 from applications a where a.job_id = ${jobs.id} and a.status in (${sql.raw(st)}))`);
  } else if (f.stage === "tailored") {
    c.push(eq(jobs.status, "scored"));
    c.push(sql`exists (select 1 from tailorings t where t.job_id = ${jobs.id})`);
  } else c.push(eq(jobs.status, (f.stage ?? "scored") as "found" | "scored" | "filtered_out" | "score_failed"));
  if (f.fresh) c.push(sql`not exists (select 1 from applications a where a.job_id = ${jobs.id})`);
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
  const [t] = await db.select({ n: sql<number>`count(*)::int` }).from(tailorings).innerJoin(jobs, eq(jobs.id, tailorings.jobId)).where(isNull(jobs.closedAt));
  const apps = await db.select({ status: applications.status, n: sql<number>`count(*)::int` }).from(applications).groupBy(applications.status);
  const app = (k: AppStage) => apps.filter((r) => (APP_STAGES[k] as readonly string[]).includes(r.status)).reduce((a, r) => a + r.n, 0);
  return {
    found: get("found"), scored: get("scored"), tailored: t?.n ?? 0, filteredOut: get("filtered_out"), failed: get("score_failed"),
    ready: app("ready"), needsYou: app("needs_you"), applied: app("applied"), interviewing: app("interviewing"), manual: app("manual"),
  };
}

export async function getApplication(jobId: number) {
  const [a] = await db.select().from(applications).where(eq(applications.jobId, jobId));
  return a ?? null;
}

/** Applications sent today (ATS submits) and LinkedIn forms filled today, for the header caps. */
export async function todayCounts(now = new Date()): Promise<{ applied: number; linkedin: number }> {
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const [r] = await db.select({
    applied: sql<number>`count(*) filter (where ${applications.appliedAt} >= ${d0}::timestamptz and ${applications.site} <> 'linkedin')::int`,
    linkedin: sql<number>`count(*) filter (where ${applications.filledAt} >= ${d0}::timestamptz and ${applications.site} = 'linkedin')::int`,
  }).from(applications);
  return { applied: r?.applied ?? 0, linkedin: r?.linkedin ?? 0 };
}

export async function latestRun() {
  const [r] = await db.select().from(runs).where(isNotNull(runs.status)).orderBy(desc(runs.id)).limit(1);
  return r ?? null;
}

export async function sourceCount(): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(distinct source)::int` }).from(jobSources);
  return r?.n ?? 0;
}

export async function getTailoring(jobId: number) {
  const [t] = await db.select().from(tailorings).where(eq(tailorings.jobId, jobId));
  return t ?? null;
}

const normReq = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9+#.\s]/g, " ").replace(/\s+/g, " ").trim();

/** How many tailored jobs list each gap (by normalized requirement text). */
export async function gapCounts(): Promise<Map<string, number>> {
  const rows = await db.select({ g: tailorings.gapReport }).from(tailorings);
  const m = new Map<string, number>();
  for (const r of rows) for (const g of (r.g as { requirement: string }[] | null) ?? []) {
    const k = normReq(g.requirement); m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}
export const gapKey = normReq;

/** The Apply tab: everything still in flight. The Applied tab: everything sent. */
export const TODO_STATUSES = ["ready_to_submit", "needs_you", "manual", "failed", "queued", "filling", "submitting"] as const;
export const SENT_STATUSES = ["interviewing", "offer", "applied", "rejected"] as const;

export type AppJob = RankedJob & { app: typeof applications.$inferSelect };

/** Lower comes first: what waits on Sherif (approve, finish, apply yourself, failed), then what the app is still doing. */
export function todoRank(a: typeof applications.$inferSelect): number {
  if (a.status === "ready_to_submit") return a.approved ? 4 : 0;
  return { needs_you: 1, manual: 2, failed: 3 }[a.status as string] ?? 4;
}

/** Jobs clearly too senior for him stay off the Apply tab (and out of Chrome's queue) unless he picked them himself. */
const notTooSenior = () => or(eq(applications.picked, true), gte(jobScores.level, TOO_SENIOR_LEVEL));

export async function listApplications(group: "todo" | "sent", w: Weights): Promise<AppJob[]> {
  const statuses = group === "todo" ? TODO_STATUSES : SENT_STATUSES;
  const rows = await db.select().from(applications).innerJoin(jobs, eq(jobs.id, applications.jobId))
    .leftJoin(jobScores, eq(jobScores.jobId, jobs.id))
    .where(and(inArray(applications.status, [...statuses]), group === "todo" ? and(isNull(jobs.closedAt), notTooSenior()) : undefined));
  const ranked = rank(rows, w, new Map()).map((r, i) => ({ ...r, app: rows[i].applications }));
  const order = (r: AppJob) => (group === "todo" ? todoRank(r.app) : SENT_STATUSES.indexOf(r.app.status as (typeof SENT_STATUSES)[number]));
  ranked.sort((a, b) => order(a) - order(b) || Number(b.app.picked) - Number(a.app.picked)
    || (group === "sent" ? +(b.app.appliedAt ?? 0) - +(a.app.appliedAt ?? 0) : 0) || (b.composite ?? -1) - (a.composite ?? -1));
  const srcs = await attachSources(ranked);
  return ranked.map((r) => ({ ...r, sources: srcs.get(r.id) ?? [] }));
}

/** Counts for the three tabs. "fresh" matches the default Jobs to look at list (takeable, open, scored, no application). */
export async function tabCounts(): Promise<{ todo: number; sent: number; fresh: number }> {
  const apps = await db.select({ status: applications.status, closed: jobs.closedAt, picked: applications.picked, level: jobScores.level })
    .from(applications).innerJoin(jobs, eq(jobs.id, applications.jobId)).leftJoin(jobScores, eq(jobScores.jobId, jobs.id));
  const [f] = await db.select({ n: sql<number>`count(*)::int` }).from(jobs).leftJoin(jobScores, eq(jobScores.jobId, jobs.id))
    .where(where({ stage: "scored", fresh: true, canTake: true }));
  return {
    todo: apps.filter((a) => !a.closed && (TODO_STATUSES as readonly string[]).includes(a.status)
      && (a.picked || (a.level ?? 0) >= TOO_SENIOR_LEVEL)).length,
    sent: apps.filter((a) => (SENT_STATUSES as readonly string[]).includes(a.status)).length,
    fresh: f?.n ?? 0,
  };
}
