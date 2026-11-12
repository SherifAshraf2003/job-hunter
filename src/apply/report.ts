import { and, eq, gte } from "drizzle-orm";
import { db } from "../db/client";
import { applications, jobs, siteEvents, sites } from "../db/schema";
import { pickApplyTarget } from "./sites";
import type { Report, Site } from "./types";

const MAX_ATTEMPTS = 3;

async function pauseSite(site: Site, reason: string, now: Date) {
  await db.insert(sites).values({ site, autoSubmit: site !== "linkedin", paused: true, pauseReason: reason, pausedAt: now })
    .onConflictDoUpdate({ target: sites.site, set: { paused: true, pauseReason: reason, pausedAt: now } });
}

/** Applies what the extension saw on the page to the application, and trips the per-site kill switch. */
export async function applyReport(jobId: number, r: Report, now: Date = new Date()): Promise<void> {
  const [a] = await db.select().from(applications).where(eq(applications.jobId, jobId));
  if (!a) return;
  const set = (v: Partial<typeof applications.$inferInsert>) =>
    db.update(applications).set({ leaseAt: null, ...v }).where(eq(applications.jobId, jobId));
  const event = (kind: "captcha" | "blocked" | "login_wall") => db.insert(siteEvents).values({ site: a.site, kind, at: now, jobId });

  switch (r.outcome) {
    case "applied":
      return void (await set({ status: "applied", appliedAt: now, reason: null }));
    case "stopped":
      return void (await set({ status: r.status ?? "needs_you", reason: r.reason ?? null }));
    case "needs_you": {
      // LinkedIn jobs that apply on the company's site: switch to that ATS when it's one we support.
      if (r.url && a.site === "linkedin") {
        const t = pickApplyTarget({ applyUrl: r.url }, []);
        if (t.site !== "other" && t.site !== "linkedin") {
          return void (await set({ status: "queued", site: t.site, boardKey: t.boardKey, targetUrl: t.url, reason: null, approved: false }));
        }
        return void (await set({ status: "needs_you", targetUrl: r.url, reason: r.reason ?? "Applies on company site" }));
      }
      return void (await set({ status: "needs_you", reason: r.reason ?? "Needs you" }));
    }
    case "closed":
      await db.update(jobs).set({ closedAt: now }).where(eq(jobs.id, jobId));
      return void (await set({ status: "skipped", reason: "Listing closed" }));
    case "failed": {
      const attempts = a.attempts + 1;
      return void (await set({ attempts, status: attempts >= MAX_ATTEMPTS ? "failed" : a.approved ? "ready_to_submit" : "queued", reason: r.reason ?? "Failed" }));
    }
    case "captcha": {
      await set({ status: "needs_you", reason: "Captcha: solve it and submit" });
      await event("captcha");
      const recent = await db.select().from(siteEvents)
        .where(and(eq(siteEvents.site, a.site), eq(siteEvents.kind, "captcha"), gte(siteEvents.at, new Date(+now - 3600_000))));
      if (recent.length >= 3) await pauseSite(a.site, "3 captchas in an hour", now);
      return;
    }
    case "blocked":
    case "login_wall":
      await set({ status: "needs_you", reason: r.outcome === "blocked" ? "Site showed an unusual activity page" : "Logged out of the site" });
      await event(r.outcome);
      await pauseSite(a.site, r.outcome === "blocked" ? "Unusual activity page" : "Logged out", now);
      return;
  }
}
