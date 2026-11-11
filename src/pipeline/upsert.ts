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

/** Same company + same role (location parts removed) = same job. */
export function jobKey(j: Pick<NormalizedJob, "companyName" | "title">): string {
  const title = j.title.replace(/\([^)]*\)/g, " ").split(/\s[-–—|]\s/)[0];
  return `${norm(j.companyName)}|${norm(title)}`;
}

export async function upsertJobs(list: NormalizedJob[]): Promise<{ inserted: number; updated: number }> {
  const { fxToUsd } = await loadSettings();
  let inserted = 0, updated = 0;
  for (const j of list) {
    const isAts = ATS_SOURCES.has(j.source);
    const s = j.salary;
    const usd = s ? toUsdYearMid(s, fxToUsd) : null;
    const [row] = await db.insert(jobs).values({
      key: jobKey(j), title: j.title, companyName: j.companyName, location: j.location, country: j.country,
      remotePolicy: j.remotePolicy, salaryMin: s?.min ?? null, salaryMax: s?.max ?? null,
      salaryCurrency: s?.currency ?? null, salaryPeriod: s?.period ?? null, salaryUsdYearMid: usd,
      descriptionText: j.descriptionText, applyUrl: j.applyUrl,
    }).onConflictDoUpdate({
      target: jobs.key,
      set: {
        lastSeenAt: sql`now()`,
        closedAt: sql`null`,
        applyUrl: isAts ? sql`excluded.apply_url` : sql`${jobs.applyUrl}`,
        descriptionText: isAts ? sql`excluded.description_text` : sql`${jobs.descriptionText}`,
        salaryMin: sql`coalesce(${jobs.salaryMin}, excluded.salary_min)`,
        salaryMax: sql`coalesce(${jobs.salaryMax}, excluded.salary_max)`,
        salaryCurrency: sql`coalesce(${jobs.salaryCurrency}, excluded.salary_currency)`,
        salaryPeriod: sql`coalesce(${jobs.salaryPeriod}, excluded.salary_period)`,
        salaryUsdYearMid: sql`coalesce(${jobs.salaryUsdYearMid}, excluded.salary_usd_year_mid)`,
        country: sql`coalesce(${jobs.country}, excluded.country)`,
      },
    }).returning({ id: jobs.id, inserted: sql<boolean>`(xmax = 0)` });
    if (row.inserted) inserted++; else updated++;
    await db.insert(jobSources).values({
      jobId: row.id, source: j.source, externalId: j.externalId, url: j.url, boardSlug: j.boardSlug ?? null,
    }).onConflictDoNothing();
  }
  return { inserted, updated };
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
