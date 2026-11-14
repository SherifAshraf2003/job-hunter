import { test, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, resetDb, closeDb } from "@/db/client";
import { applications, jobs, jobScores, profile, spend, tailorings } from "@/db/schema";
import { saveSetting } from "@/config";
import { parseResumeFile } from "@/profile/load";
import { buildFillPlan } from "@/apply/plan";
import { seedBank } from "@/apply/bank";
import type { FormField } from "@/apply/types";

beforeEach(async () => {
  await resetDb(); vi.restoreAllMocks();
  await db.insert(profile).values({ id: 1, data: parseResumeFile() });
  await saveSetting("trustRemaining", 0);
  await saveSetting("dryRun", false);
});
afterAll(async () => { await closeDb(); });

async function mkJob(o: { salary?: boolean; url?: string } = {}) {
  const url = o.url ?? "https://job-boards.greenhouse.io/acme/jobs/1";
  const [j] = await db.insert(jobs).values({
    key: `acme|eng${Math.random()}`, title: "AI Engineer", companyName: "Acme", applyUrl: url, status: "scored", country: "US", remotePolicy: "remote",
    ...(o.salary === false ? {} : { salaryMin: 150000, salaryMax: 180000, salaryCurrency: "USD", salaryPeriod: "year" as const }),
  }).returning();
  await db.insert(jobScores).values({ jobId: j.id, engine: "jev", scope: 80, company: 80, pay: 80, level: 80, fit: 80, canTake: "remote_from_egypt", canTakeConfidence: 0.9 });
  await db.insert(tailorings).values({ jobId: j.id, tier: "middle", model: "m", pdfPath: "/tmp/x.pdf", coverLetter: "Hello" });
  await db.insert(applications).values({ jobId: j.id, site: url.includes("linkedin") ? "linkedin" : "greenhouse", boardKey: "greenhouse:acme", targetUrl: url, status: "filling" });
  return j.id;
}
const f = (id: string, label: string, o: Partial<FormField> = {}): FormField => ({ id, label, kind: "text", required: true, ...o });
const basics = [f("fn", "First Name"), f("ln", "Last Name"), f("em", "Email", { kind: "email" }), f("cv", "Resume/CV", { kind: "file" })];
const llm = (answers: Record<string, string | null>) => vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ answers }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0005 },
}), { status: 200 }));

test("no salary posted stops even when everything else is known", async () => {
  const id = await mkJob({ salary: false });
  const p = await buildFillPlan(id, [...basics, f("sal", "Expected salary")]);
  expect(p).toMatchObject({ action: "stop", status: "needs_you", reason: "No salary posted" });
});

test("all known on an ATS with trust done and dry run off submits", async () => {
  const id = await mkJob();
  const spy = llm({});
  const p = await buildFillPlan(id, [...basics, f("sal", "Expected salary")]);
  expect(p).toMatchObject({ action: "submit", status: "applied_pending", reason: null });
  expect(spy).not.toHaveBeenCalled();
  expect(p.fills.find((x) => x.id === "sal")?.value).toBe("149,000 USD per year");
  const [a] = await db.select().from(applications).where(eq(applications.jobId, id));
  expect(a.fills).toHaveLength(5);
  expect(a.filledAt).not.toBeNull();
});

test("required field without answer stops", async () => {
  const id = await mkJob();
  llm({ sec: null });
  const p = await buildFillPlan(id, [...basics, f("sec", "Security clearance level")]);
  expect(p.action).toBe("stop");
  expect(p.status).toBe("needs_you");
  expect(p.reason).toContain("Security clearance level");
});

test("linkedin never submits", async () => {
  const id = await mkJob({ url: "https://www.linkedin.com/jobs/view/123/" });
  const p = await buildFillPlan(id, basics);
  expect(p).toMatchObject({ action: "stop", status: "needs_you", reason: "LinkedIn: review and submit" });
});

test("trust period holds auto-submit", async () => {
  const id = await mkJob();
  await saveSetting("trustRemaining", 3);
  expect(await buildFillPlan(id, basics)).toMatchObject({ action: "stop", status: "ready_to_submit" });
  await db.update(applications).set({ approved: true }).where(eq(applications.jobId, id));
  expect(await buildFillPlan(id, basics)).toMatchObject({ action: "submit", status: "applied_pending" });
});

test("dry run never submits", async () => {
  const id = await mkJob();
  await saveSetting("dryRun", true);
  await db.update(applications).set({ approved: true }).where(eq(applications.jobId, id));
  const p = await buildFillPlan(id, basics);
  expect(p.action).toBe("stop");
  expect(p.reason).toMatch(/Dry run/);
});

test("budget out: no LLM call, unknown required field goes to needs_you", async () => {
  const id = await mkJob();
  await db.insert(spend).values({ category: "tailoring", provider: "openrouter", model: "m", usd: 9.999 });
  const spy = llm({ q: "anything" });
  const p = await buildFillPlan(id, [...basics, f("q", "Describe your experience with Kafka")]);
  expect(spy).not.toHaveBeenCalled();
  expect(p).toMatchObject({ action: "stop", status: "needs_you" });
});

test("drafted option outside choices is null", async () => {
  const id = await mkJob();
  llm({ pick: "Maybe" });
  const p = await buildFillPlan(id, [...basics, f("pick", "Preferred team", { kind: "select", options: ["Platform", "Product"] })]);
  expect(p.status).toBe("needs_you");
  expect(p.fills.find((x) => x.id === "pick")).toBeUndefined();
});

test("bank answer used before LLM", async () => {
  const id = await mkJob();
  await seedBank({ phone: "+20 100 000 0000", city: "Cairo, Egypt", noticePeriod: "2 weeks", relocate: "Yes", heardFrom: "Job board" });
  const spy = llm({});
  const p = await buildFillPlan(id, [...basics, f("ph", "Phone *")]);
  expect(spy).not.toHaveBeenCalled();
  expect(p.fills.find((x) => x.id === "ph")).toMatchObject({ value: "+20 100 000 0000", source: "bank" });
});
