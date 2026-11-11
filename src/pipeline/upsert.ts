import { and, eq, isNull, notInArray, sql, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { jobs, jobSources } from "../db/schema";
import { toUsdYearMid } from "../sources/text";
import { loadSettings } from "../config";
import type { BoardRef, NormalizedJob } from "../sources/types";

const ATS_SOURCES = new Set(["greenhouse", "lever", "ashby", "workable"]);

function norm(s: string): string {
  return s.toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(inc|llc|ltd|gmbh|co|corp|limited|technologies|labs)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

/**
 * Same company + same role = same job, so a posting found on several sources merges into one row.
 * Parenthetical notes like "(Remote)" are dropped; " - Team" suffixes are kept because they name different roles.
 */
export function jobKey(j: Pick<NormalizedJob, "companyName" | "title">): string {
  const title = j.title.replace(/\([^)]*\)/g, " ");
  return `${norm(j.companyName)}|${norm(title)}`;
}

function rowValues(j: NormalizedJob, key: string, usd: number | null) {
  const s = j.salary;
  return {
    key, title: j.title, companyName: j.companyName, location: j.location, country: j.country,
    remotePolicy: j.remotePolicy, salaryMin: s?.min ?? null, salaryMax: s?.max ?? null,
    salaryCurrency: s?.currency ?? null, salaryPeriod: s?.period ?? null, salaryUsdYearMid: usd,
    descriptionText: j.descriptionText, applyUrl: j.applyUrl,
  };
}

export async function upsertJobs(list: NormalizedJob[]): Promise<{ inserted: number; updated: number }> {
  const { fxToUsd } = await loadSettings();
  let inserted = 0, updated = 0;
  for (const j of list) {
    const isAts = ATS_SOURCES.has(j.source);
    const usd = j.salary ? toUsdYearMid(j.salary, fxToUsd) : null;

    // 1) This exact posting was seen before: update its row, even if the title changed since.
    const [known] = await db.select({ jobId: jobSources.jobId }).from(jobSources)
      .where(and(eq(jobSources.source, j.source), eq(jobSources.externalId, j.externalId)));
    if (known) {
      const { key: _k, ...fields } = rowValues(j, "", usd);
      await db.update(jobs).set({
        ...(isAts ? fields : {}),
        lastSeenAt: sql`now()`, closedAt: null,
      }).where(eq(jobs.id, known.jobId));
      updated++;
      continue;
    }

    // 2) Another posting from the same source already owns this key (e.g. the same title in two locations):
    //    keep them as separate jobs instead of mixing their locations.
    let key = jobKey(j);
    const [clash] = await db.select({ id: jobs.id }).from(jobs)
      .innerJoin(jobSources, eq(jobSources.jobId, jobs.id))
      .where(and(eq(jobs.key, key), eq(jobSources.source, j.source))).limit(1);
    if (clash) key = `${key}#${j.source}:${j.externalId}`;

    // 3) New posting: insert, or merge into the same role found on another source.
    const [row] = await db.insert(jobs).values(rowValues(j, key, usd)).onConflictDoUpdate({
      target: jobs.key,
      set: {
        lastSeenAt: sql`now()`,
        closedAt: sql`null`,
        applyUrl: isAts ? sql`excluded.apply_url` : sql`${jobs.applyUrl}`,
        descriptionText: isAts ? sql`excluded.description_text` : sql`${jobs.descriptionText}`,
        location: isAts ? sql`excluded.location` : sql`${jobs.location}`,
        remotePolicy: isAts ? sql`excluded.remote_policy` : sql`${jobs.remotePolicy}`,
        country: isAts ? sql`coalesce(excluded.country, ${jobs.country})` : sql`coalesce(${jobs.country}, excluded.country)`,
        salaryMin: sql`coalesce(${jobs.salaryMin}, excluded.salary_min)`,
        salaryMax: sql`coalesce(${jobs.salaryMax}, excluded.salary_max)`,
        salaryCurrency: sql`coalesce(${jobs.salaryCurrency}, excluded.salary_currency)`,
        salaryPeriod: sql`coalesce(${jobs.salaryPeriod}, excluded.salary_period)`,
        salaryUsdYearMid: sql`coalesce(${jobs.salaryUsdYearMid}, excluded.salary_usd_year_mid)`,
      },
    }).returning({ id: jobs.id, inserted: sql<boolean>`(xmax = 0)` });
    if (row.inserted) inserted++; else updated++;
    await db.insert(jobSources).values({
      jobId: row.id, source: j.source, externalId: j.externalId, url: j.url, boardSlug: j.boardSlug ?? null,
    }).onConflictDoNothing();
  }
  return { inserted, updated };
}

/** Closes jobs found only on feeds (no company board) once they haven't been seen for a while. */
export async function closeStaleFeedJobs(): Promise<number> {
  const res = await db.execute(sql`
    update jobs set closed_at = now()
    where closed_at is null
      and not exists (select 1 from job_sources s where s.job_id = jobs.id and s.source in ('greenhouse','lever','ashby','workable'))
      and (
        (exists (select 1 from job_sources s where s.job_id = jobs.id and s.source = 'hn') and last_seen_at < now() - interval '45 days')
        or (not exists (select 1 from job_sources s where s.job_id = jobs.id and s.source = 'hn') and last_seen_at < now() - interval '14 days')
      )
    returning id`);
  return (res as unknown as unknown[]).length;
}

/** Marks jobs from this board as closed when the latest fetch no longer lists them. Never deletes. */
export async function markClosed(ref: BoardRef, seenExternalIds: string[]): Promise<number> {
  const fromBoard = and(eq(jobSources.source, ref.ats), eq(jobSources.boardSlug, ref.slug));
  const missing = db.select({ id: jobSources.jobId }).from(jobSources)
    .where(seenExternalIds.length ? and(fromBoard, notInArray(jobSources.externalId, seenExternalIds)) : fromBoard);
  const stillListed = seenExternalIds.length
    ? db.select({ id: jobSources.jobId }).from(jobSources).where(and(fromBoard, inArray(jobSources.externalId, seenExternalIds)))
    : null;
  const res = await db.update(jobs).set({ closedAt: sql`now()` })
    .where(and(
      isNull(jobs.closedAt),
      inArray(jobs.id, missing),
      ...(stillListed ? [notInArray(jobs.id, stillListed)] : []),
    ))
    .returning({ id: jobs.id });
  return res.length;
}
