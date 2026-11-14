import { test, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, resetDb, closeDb } from "@/db/client";
import { applications, jobs, jobScores, sites, tailorings } from "@/db/schema";
import { saveSetting, loadSettings } from "@/config";
import { queueApplications, nextApplication, approve } from "@/apply/queue";

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const NOW = new Date(2026, 10, 12, 12, 0, 0);
let n = 0;

async function mkJob(o: { score: number; url?: string; company?: string }) {
  n++;
  const company = o.company ?? `Co${n}`;
  const url = o.url ?? `https://job-boards.greenhouse.io/co${n}/jobs/${n}`;
  const [j] = await db.insert(jobs).values({ key: `${company}|role${n}`, title: `Engineer ${n}`, companyName: company, applyUrl: url, status: "scored" }).returning();
  await db.insert(jobScores).values({ jobId: j.id, engine: "jev", scope: o.score, company: o.score, pay: o.score, level: o.score, fit: o.score, canTake: "remote_from_egypt", canTakeConfidence: 0.9 });
  await db.insert(tailorings).values({ jobId: j.id, tier: "middle", model: "m", pdfPath: `/tmp/${j.id}.pdf` });
  return j.id;
}
const setApp = (jobId: number, v: Partial<typeof applications.$inferInsert>) => db.update(applications).set(v).where(eq(applications.jobId, jobId));
const status = async (jobId: number) => (await db.select().from(applications).where(eq(applications.jobId, jobId)))[0];

test("hands out best composite first", async () => {
  const low = await mkJob({ score: 70 });
  const high = await mkJob({ score: 90 });
  await queueApplications();
  const r = await nextApplication(NOW);
  expect(r).toMatchObject({ jobId: high, mode: "fill", site: "greenhouse" });
  expect((await status(high)).status).toBe("filling");
  expect((await status(low)).status).toBe("queued");
});

test("per-board daily cap", async () => {
  const done = [];
  for (let i = 0; i < 3; i++) done.push(await mkJob({ score: 60, url: `https://job-boards.greenhouse.io/acme/jobs/${i}`, company: `Acme${i}` }));
  const fourth = await mkJob({ score: 95, url: "https://job-boards.greenhouse.io/acme/jobs/9", company: "Acme9" });
  const other = await mkJob({ score: 80 });
  await queueApplications();
  for (const id of done) await setApp(id, { status: "applied", appliedAt: NOW });
  const r = await nextApplication(NOW);
  expect(r).toMatchObject({ jobId: other });
  expect((await status(fourth)).status).toBe("queued");
});

test("linkedin cap counts fills", async () => {
  const ids = [];
  for (let i = 0; i < 16; i++) ids.push(await mkJob({ score: 70, url: `https://www.linkedin.com/jobs/view/${1000 + i}/` }));
  await queueApplications();
  for (const id of ids.slice(0, 15)) await setApp(id, { status: "needs_you", filledAt: NOW });
  const r = await nextApplication(NOW);
  expect(r).toHaveProperty("idle");
});

test("per-company 30d limit", async () => {
  const a = await mkJob({ score: 60, company: "Acme" });
  const b = await mkJob({ score: 60, company: "Acme" });
  const c = await mkJob({ score: 90, company: "Acme" });
  await queueApplications();
  const tenDaysAgo = new Date(+NOW - 10 * 86400_000);
  await setApp(a, { status: "applied", appliedAt: tenDaysAgo, queuedAt: tenDaysAgo });
  await setApp(b, { status: "applied", appliedAt: tenDaysAgo, queuedAt: tenDaysAgo });
  expect(await nextApplication(NOW)).toHaveProperty("idle");
  const old = new Date(+NOW - 31 * 86400_000);
  await setApp(a, { queuedAt: old, appliedAt: old });
  await setApp(b, { queuedAt: old, appliedAt: old });
  expect(await nextApplication(NOW)).toMatchObject({ jobId: c });
});

test("paused site skipped and global pause idles", async () => {
  await mkJob({ score: 90, url: "https://jobs.lever.co/acme/1" });
  const gh = await mkJob({ score: 70 });
  await queueApplications();
  await db.insert(sites).values({ site: "lever", paused: true, pauseReason: "test" });
  expect(await nextApplication(NOW)).toMatchObject({ jobId: gh });
  await setApp(gh, { status: "queued", leaseAt: null });
  await saveSetting("globalPause", true);
  expect(await nextApplication(NOW)).toEqual({ idle: "Paused" });
});

test("approved ready job comes first in submit mode", async () => {
  await mkJob({ score: 95 });
  const ready = await mkJob({ score: 60 });
  await queueApplications();
  await setApp(ready, { status: "ready_to_submit" });
  await approve(ready);
  expect(await nextApplication(NOW)).toMatchObject({ jobId: ready, mode: "submit" });
  expect((await status(ready)).status).toBe("submitting");
});

test("stale lease returns to queue", async () => {
  const id = await mkJob({ score: 80 });
  await queueApplications();
  await setApp(id, { status: "filling", leaseAt: new Date(+NOW - 11 * 60_000), attempts: 0 });
  expect(await nextApplication(NOW)).toMatchObject({ jobId: id, mode: "fill" });
  expect((await status(id)).attempts).toBe(1);
});

test("fresh lease is not handed out twice", async () => {
  const id = await mkJob({ score: 80 });
  await queueApplications();
  expect(await nextApplication(NOW)).toMatchObject({ jobId: id });
  expect(await nextApplication(new Date(+NOW + 60_000))).toHaveProperty("idle");
});

test("approval never drives trustRemaining below 0", async () => {
  const id = await mkJob({ score: 80 });
  await queueApplications();
  await setApp(id, { status: "ready_to_submit" });
  await saveSetting("trustRemaining", 0);
  await approve(id);
  expect((await loadSettings()).trustRemaining).toBe(0);
  expect((await status(id)).approved).toBe(true);
});

test("queueApplications marks unsupported sites manual", async () => {
  const id = await mkJob({ score: 80, url: "https://remoteok.com/remote-jobs/123" });
  const r = await queueApplications();
  expect(r).toEqual({ queued: 0, manual: 1 });
  expect((await status(id)).status).toBe("manual");
});

test("approved jobs still respect the daily caps", async () => {
  const done = [];
  for (let i = 0; i < 3; i++) done.push(await mkJob({ score: 60, url: `https://job-boards.greenhouse.io/acme/jobs/${i}`, company: `Acme${i}` }));
  const ready = await mkJob({ score: 90, url: "https://job-boards.greenhouse.io/acme/jobs/9", company: "Acme9" });
  await queueApplications();
  for (const id of done) await setApp(id, { status: "applied", appliedAt: NOW });
  await setApp(ready, { status: "ready_to_submit", approved: true });
  expect(await nextApplication(NOW)).toHaveProperty("idle");
});

test("approving during dry run does not use up the trust period", async () => {
  const id = await mkJob({ score: 80 });
  await queueApplications();
  await setApp(id, { status: "ready_to_submit" });
  await saveSetting("dryRun", true);
  await saveSetting("trustRemaining", 10);
  await approve(id);
  expect((await loadSettings()).trustRemaining).toBe(10);
  await saveSetting("dryRun", false);
  const id2 = await mkJob({ score: 70 });
  await queueApplications();
  await setApp(id2, { status: "ready_to_submit" });
  await approve(id2);
  expect((await loadSettings()).trustRemaining).toBe(9);
});

test("skipped or closed jobs are never handed out", async () => {
  const skipped = await mkJob({ score: 95 });
  const closed = await mkJob({ score: 90 });
  const ok = await mkJob({ score: 50 });
  await queueApplications();
  await db.update(jobs).set({ status: "filtered_out" }).where(eq(jobs.id, skipped));
  await db.update(jobs).set({ closedAt: NOW }).where(eq(jobs.id, closed));
  expect(await nextApplication(NOW)).toMatchObject({ jobId: ok });
});

test("a stale submitting lease goes to needs_you, never back to the queue", async () => {
  const id = await mkJob({ score: 80 });
  await queueApplications();
  await setApp(id, { status: "submitting", leaseAt: new Date(+NOW - 11 * 60_000) });
  expect(await nextApplication(NOW)).toHaveProperty("idle");
  expect(await status(id)).toMatchObject({ status: "needs_you" });
  expect((await status(id)).reason).toMatch(/check/i);
});

test("a lease is only taken from a queued row", async () => {
  const id = await mkJob({ score: 80 });
  await queueApplications();
  const [a, b] = await Promise.all([nextApplication(NOW), nextApplication(NOW)]);
  expect([a, b].filter((r) => "jobId" in r)).toHaveLength(1);
  expect((await status(id)).status).toBe("filling");
});

test("a queued job re-scored as not possible is never handed out", async () => {
  const blocked = await mkJob({ score: 95 });
  const ok = await mkJob({ score: 60 });
  await queueApplications();
  await db.update(jobScores).set({ canTake: "not_possible" }).where(eq(jobScores.jobId, blocked));
  const r = await nextApplication(NOW);
  expect(r).toMatchObject({ jobId: ok });
  expect((await status(blocked)).status).toBe("queued");
});
