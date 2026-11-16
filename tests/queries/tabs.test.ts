import { test, expect, beforeEach, afterAll } from "vitest";
import { db, resetDb, closeDb } from "@/db/client";
import { applications, jobs, jobScores } from "@/db/schema";
import { listApplications, listJobs, tabCounts } from "@/queries/jobs";
import { config } from "@/config";

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

let n = 0;
async function mk(score: number, app?: Partial<typeof applications.$inferInsert>) {
  n++;
  const [j] = await db.insert(jobs).values({ key: `c${n}|r`, title: `Role ${n}`, companyName: `C${n}`, applyUrl: "https://x", status: "scored" }).returning();
  await db.insert(jobScores).values({ jobId: j.id, engine: "jev", scope: score, company: score, pay: score, level: score, fit: score, canTake: "remote_from_egypt", canTakeConfidence: 0.9 });
  if (app) await db.insert(applications).values({ jobId: j.id, site: "greenhouse", boardKey: "gh:x", targetUrl: "https://x", ...app });
  return j.id;
}

test("Apply tab: things waiting on Sherif first, then work in progress", async () => {
  const queued = await mk(99, { status: "queued" });
  const needs = await mk(50, { status: "needs_you" });
  const ready = await mk(40, { status: "ready_to_submit" });
  const manual = await mk(90, { status: "manual" });
  await mk(80, { status: "applied" });
  const ids = (await listApplications("todo", config.weights)).map((r) => r.id);
  expect(ids).toEqual([ready, needs, manual, queued]);
});

test("Applied tab: interviewing and offers on top, rejections last", async () => {
  const rej = await mk(90, { status: "rejected" });
  const app = await mk(80, { status: "applied" });
  const int = await mk(50, { status: "interviewing" });
  const ids = (await listApplications("sent", config.weights)).map((r) => r.id);
  expect(ids).toEqual([int, app, rej]);
});

test("Jobs to look at: only jobs without an application", async () => {
  const fresh = await mk(70);
  await mk(90, { status: "queued" });
  const ids = (await listJobs({ stage: "scored", fresh: true }, config.weights)).map((r) => r.id);
  expect(ids).toEqual([fresh]);
  expect(await tabCounts()).toEqual({ todo: 1, sent: 0, fresh: 1 });
});
