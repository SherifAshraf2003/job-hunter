import { and, eq, inArray, isNotNull, isNull, lt, ne } from "drizzle-orm";
import { db } from "../db/client";
import { applications, jobs, jobScores, jobSources, sites, tailorings } from "../db/schema";
import { loadSettings, saveSetting } from "../config";
import { composite } from "../scoring/composite";
import { pickApplyTarget } from "./sites";
import type { Site } from "./types";

const LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const ATS: Site[] = ["greenhouse", "lever", "ashby", "workable"];

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a: Date | null, d0: Date) => !!a && a >= d0 && +a < +d0 + 86400_000;
const normCompany = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Adds every tailored, open, takeable job without an application row to the queue. Unsupported sites are "manual". */
export async function queueApplications(): Promise<{ queued: number; manual: number }> {
  const rows = await db.select({ id: jobs.id, applyUrl: jobs.applyUrl }).from(jobs)
    .innerJoin(tailorings, eq(tailorings.jobId, jobs.id))
    .innerJoin(jobScores, eq(jobScores.jobId, jobs.id))
    .leftJoin(applications, eq(applications.jobId, jobs.id))
    .where(and(isNotNull(tailorings.pdfPath), isNull(jobs.closedAt), ne(jobScores.canTake, "not_possible"), isNull(applications.jobId)));
  const out = { queued: 0, manual: 0 };
  if (!rows.length) return out;
  const srcs = await db.select().from(jobSources).where(inArray(jobSources.jobId, rows.map((r) => r.id)));
  for (const r of rows) {
    const t = pickApplyTarget(r, srcs.filter((s) => s.jobId === r.id));
    const manual = t.site === "other";
    await db.insert(applications).values({
      jobId: r.id, site: t.site, boardKey: t.boardKey, targetUrl: t.url, status: manual ? "manual" : "queued",
      reason: manual ? "This site isn't supported yet; apply yourself" : null,
    }).onConflictDoNothing();
    if (manual) out.manual++; else out.queued++;
  }
  return out;
}

/**
 * Leases that outlived the extension (tab closed, crash). A fill goes back to the queue, counting as an attempt.
 * A submit never does: the form may already have been sent, so it waits for Sherif to check.
 */
async function reclaimStaleLeases(now: Date) {
  const stale = await db.select().from(applications)
    .where(and(inArray(applications.status, ["filling", "submitting"]), lt(applications.leaseAt, new Date(+now - LEASE_MS))));
  for (const a of stale) {
    if (a.status === "submitting") {
      await db.update(applications).set({ status: "needs_you", leaseAt: null, reason: "Submitted? check the tab: the browser never confirmed it" })
        .where(eq(applications.jobId, a.jobId));
      continue;
    }
    const attempts = a.attempts + 1;
    const back = attempts >= MAX_ATTEMPTS ? "failed" : "queued";
    await db.update(applications).set({ status: back, attempts, leaseAt: null, reason: back === "failed" ? "Gave up after 3 tries (the tab never reported back)" : a.reason })
      .where(eq(applications.jobId, a.jobId));
  }
}

/**
 * The next job for the extension, respecting every guardrail: global pause, paused sites, per-site,
 * per-board and global daily caps, and the per-company 30-day limit. Approved "Ready to submit" jobs go first.
 */
export async function nextApplication(now: Date = new Date()): Promise<{ jobId: number; url: string; site: Site; mode: "fill" | "submit" } | { idle: string }> {
  await reclaimStaleLeases(now);
  const cfg = await loadSettings();
  if (cfg.globalPause) return { idle: "Paused" };

  const siteRows = await db.select().from(sites);
  const paused = new Set(siteRows.filter((s) => s.paused).map((s) => s.site));
  const siteCap = new Map(siteRows.filter((s) => s.dailyCap != null).map((s) => [s.site, s.dailyCap!]));

  const all = await db.select({ a: applications, company: jobs.companyName, jobStatus: jobs.status, closedAt: jobs.closedAt, s: jobScores }).from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(jobScores, eq(jobScores.jobId, jobs.id));
  const d0 = dayStart(now);
  const appliedToday = all.filter((r) => sameDay(r.a.appliedAt, d0) || r.a.status === "submitting");
  const linkedinFilledToday = all.filter((r) => r.a.site === "linkedin" && sameDay(r.a.filledAt, d0)).length;
  const atsToday = appliedToday.filter((r) => ATS.includes(r.a.site)).length;
  const since30 = new Date(+now - 30 * 86400_000);
  const companyCount = new Map<string, number>();
  for (const r of all) {
    if (["queued", "skipped", "failed", "manual"].includes(r.a.status) || r.a.queuedAt < since30) continue;
    const k = normCompany(r.company);
    companyCount.set(k, (companyCount.get(k) ?? 0) + 1);
  }

  /** Takes the job only if nobody else did in the meantime (two ticks at once must not both get it). */
  const lease = async (jobId: number, from: "queued" | "ready_to_submit", status: "filling" | "submitting") =>
    (await db.update(applications).set({ status, leaseAt: now })
      .where(and(eq(applications.jobId, jobId), eq(applications.status, from))).returning({ id: applications.jobId })).length > 0;

  let reason = "Nothing queued";
  /** Site, board and global daily caps. Approved jobs are held by these too: approving 80 jobs must not send 80 today. */
  const capped = (r: (typeof all)[number]) => {
    const site = r.a.site;
    if (site === "linkedin") return linkedinFilledToday >= (siteCap.get("linkedin") ?? cfg.caps.linkedinDaily);
    if (siteCap.has(site) && appliedToday.filter((x) => x.a.site === site).length >= siteCap.get(site)!) return true;
    if (appliedToday.filter((x) => x.a.boardKey === r.a.boardKey).length >= cfg.caps.perBoardDaily) return true;
    if (atsToday >= cfg.caps.globalDaily) { reason = "Daily application cap reached"; return true; }
    return false;
  };
  // Jobs Sherif skipped, and listings that closed, are never handed out.
  const live = (r: (typeof all)[number]) => r.jobStatus !== "filtered_out" && !r.closedAt && !paused.has(r.a.site);
  const best = (x: (typeof all)[number], y: (typeof all)[number]) => composite(y.s, cfg.weights).score - composite(x.s, cfg.weights).score;

  for (const r of all.filter((r) => r.a.status === "ready_to_submit" && r.a.approved && live(r)).sort(best)) {
    if (capped(r)) continue;
    if (await lease(r.a.jobId, "ready_to_submit", "submitting")) return { jobId: r.a.jobId, url: r.a.targetUrl, site: r.a.site, mode: "submit" };
  }

  const queued = all.filter((r) => r.a.status === "queued" && live(r)).sort(best);
  if (queued.length && reason === "Nothing queued") reason = "Every queued job is held by a cap or a pause";
  for (const r of queued) {
    if (capped(r)) continue;
    if ((companyCount.get(normCompany(r.company)) ?? 0) >= cfg.caps.perCompany30d) continue;
    if (await lease(r.a.jobId, "queued", "filling")) return { jobId: r.a.jobId, url: r.a.targetUrl, site: r.a.site, mode: "fill" };
  }
  return { idle: reason };
}

/**
 * One-click approval of a "Ready to submit" job. Each approval counts down the trust period, never below 0.
 * Approvals during dry run don't count: the trust period is about real submissions.
 */
export async function approve(jobId: number): Promise<void> {
  const [a] = await db.select().from(applications).where(eq(applications.jobId, jobId));
  if (!a || a.status !== "ready_to_submit" || a.approved) return;
  await db.update(applications).set({ approved: true }).where(eq(applications.jobId, jobId));
  const { trustRemaining, dryRun } = await loadSettings();
  if (!dryRun) await saveSetting("trustRemaining", Math.max(0, trustRemaining - 1));
}

/** "Fill again in Chrome": a job that needs Sherif goes back to the queue for a fresh fill. */
export async function refill(jobId: number): Promise<void> {
  await db.update(applications).set({ status: "queued", approved: false, leaseAt: null, reason: null })
    .where(and(eq(applications.jobId, jobId), inArray(applications.status, ["needs_you", "ready_to_submit", "failed"])));
}

