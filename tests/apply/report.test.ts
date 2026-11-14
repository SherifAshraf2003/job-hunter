import { test, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, resetDb, closeDb } from "@/db/client";
import { applications, jobs, siteEvents, sites } from "@/db/schema";
import { applyReport } from "@/apply/report";

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const NOW = new Date(2026, 10, 12, 12, 0, 0);
async function mk(site: "greenhouse" | "linkedin" = "greenhouse") {
  const [j] = await db.insert(jobs).values({ key: `k${Math.random()}`, title: "Eng", companyName: "Acme", applyUrl: "https://x", status: "scored" }).returning();
  await db.insert(applications).values({ jobId: j.id, site, boardKey: "greenhouse:acme", targetUrl: "https://x", status: "filling", leaseAt: NOW });
  return j.id;
}
const app = async (id: number) => (await db.select().from(applications).where(eq(applications.jobId, id)))[0];
const siteRow = async (s: "greenhouse" | "linkedin") => (await db.select().from(sites).where(eq(sites.site, s)))[0];

test("applied report marks applied", async () => {
  const id = await mk();
  await applyReport(id, { outcome: "applied" }, NOW);
  expect(await app(id)).toMatchObject({ status: "applied", leaseAt: null });
  expect((await app(id)).appliedAt).toEqual(NOW);
});

test("closed report closes job and skips application", async () => {
  const id = await mk();
  await applyReport(id, { outcome: "closed" }, NOW);
  expect(await app(id)).toMatchObject({ status: "skipped", reason: "Listing closed" });
  const [j] = await db.select().from(jobs).where(eq(jobs.id, id));
  expect(j.closedAt).toEqual(NOW);
});

test("third captcha in an hour pauses the site, two do not", async () => {
  for (let i = 0; i < 2; i++) await applyReport(await mk(), { outcome: "captcha" }, new Date(+NOW + i * 60_000));
  expect((await siteRow("greenhouse"))?.paused ?? false).toBe(false);
  const id = await mk();
  await applyReport(id, { outcome: "captcha" }, new Date(+NOW + 5 * 60_000));
  expect(await app(id)).toMatchObject({ status: "needs_you", reason: "Captcha: solve it and submit" });
  expect(await siteRow("greenhouse")).toMatchObject({ paused: true, pauseReason: "3 captchas in an hour" });
});

test("captchas spread over two hours do not pause", async () => {
  for (let i = 0; i < 3; i++) await applyReport(await mk(), { outcome: "captcha" }, new Date(+NOW + i * 50 * 60_000));
  expect((await siteRow("greenhouse"))?.paused ?? false).toBe(false);
  expect(await db.select().from(siteEvents)).toHaveLength(3);
});

test("blocked pauses immediately", async () => {
  const id = await mk("linkedin");
  await applyReport(id, { outcome: "blocked" }, NOW);
  expect(await siteRow("linkedin")).toMatchObject({ paused: true, pauseReason: "Unusual activity page" });
  expect((await app(id)).status).toBe("needs_you");
});

test("failed retries twice then fails", async () => {
  const id = await mk();
  await applyReport(id, { outcome: "failed", reason: "boom" }, NOW);
  expect(await app(id)).toMatchObject({ status: "queued", attempts: 1 });
  await applyReport(id, { outcome: "failed", reason: "boom" }, NOW);
  expect(await app(id)).toMatchObject({ status: "queued", attempts: 2 });
  await applyReport(id, { outcome: "failed", reason: "boom" }, NOW);
  expect(await app(id)).toMatchObject({ status: "failed", attempts: 3, reason: "boom" });
});

test("stopped report takes the plan's status", async () => {
  const id = await mk();
  await applyReport(id, { outcome: "stopped", reason: "LinkedIn: review and submit", status: "needs_you" }, NOW);
  expect(await app(id)).toMatchObject({ status: "needs_you", reason: "LinkedIn: review and submit" });
  const id2 = await mk();
  await applyReport(id2, { outcome: "stopped", status: "ready_to_submit" }, NOW);
  expect(await app(id2)).toMatchObject({ status: "ready_to_submit" });
});

test("submitting report marks the job submitting, and a failure after it goes to needs_you", async () => {
  const id = await mk();
  await applyReport(id, { outcome: "submitting" }, NOW);
  expect(await app(id)).toMatchObject({ status: "submitting" });
  await applyReport(id, { outcome: "failed", reason: "Tab was closed" }, NOW);
  expect(await app(id)).toMatchObject({ status: "needs_you", attempts: 0 });
  expect((await app(id)).reason).toMatch(/submitted\? check/i);
});
