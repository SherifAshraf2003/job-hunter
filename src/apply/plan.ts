import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { answers, applications, jobs, jobScores, sites, tailorings } from "../db/schema";
import { loadSettings } from "../config";
import { loadProfile } from "../profile/load";
import { chatJSON } from "../llm/openrouter";
import { generateExtras } from "../tailor/generate";
import { pickTreatment, TOP_MODEL, MID_MODEL } from "../tailor/tiers";
import { answerByRule, classify } from "./rules";
import { lookupBank, saveDrafted } from "./bank";
import type { Fill, FillPlan, FormField } from "./types";

const DRAFT_SYSTEM = `You answer job application form questions for Sherif, a software engineer, using ONLY the facts given (his resume profile and his saved answers).
- If the facts don't answer a question, return null for it. Never guess or invent experience, numbers, tools, or personal details.
- For "select" and "radio" fields, return one of the given options exactly as written, or null.
- For "why_us" questions: 2-4 sentences, specific to this company and role from the listing, plain and direct, only real facts from his profile.
Return JSON: {"answers": {"<field id>": string | null}}`;

/** Matches a drafted answer to one of the field's options (case and spacing insensitive); anything else is null. */
function matchOption(f: FormField, v: string): string | null {
  if (!f.options?.length || !["select", "radio"].includes(f.kind)) return v;
  const n = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return f.options.find((o) => n(o) === n(v)) ?? null;
}

/**
 * Decides what goes in every field of one application form, and whether to submit.
 * Order: fixed rules and profile facts, then the answer bank, then the cover letter, then ONE model call
 * for everything left. The decision rules (salary, unknown required fields, LinkedIn, auto-submit, trust
 * period, dry run) come last and only ever make the plan more cautious.
 */
export async function buildFillPlan(jobId: number, fields: FormField[]): Promise<FillPlan> {
  const [row] = await db.select({ job: jobs, s: jobScores, t: tailorings, a: applications }).from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(jobScores, eq(jobScores.jobId, jobs.id))
    .innerJoin(tailorings, eq(tailorings.jobId, jobs.id))
    .where(eq(applications.jobId, jobId));
  if (!row) throw new Error(`No application for job ${jobId}`);
  const { job, s, t, a } = row;
  const cfg = await loadSettings();
  const profile = await loadProfile();
  const ctx = { profile, job, canTake: s.canTake, salaryRule: cfg.salaryRule };

  const fills = new Map<string, Fill>();
  const open: FormField[] = [];
  let noSalary = false;
  let coverLetter = t.coverLetter;
  const ensureCover = async () => {
    if (coverLetter) return coverLetter;
    try {
      const ex = await generateExtras(job, profile, pickTreatment(t.tier, 0), { coverLetter: true, insights: false });
      coverLetter = ex.coverLetter;
      if (coverLetter) await db.update(tailorings).set({ coverLetter }).where(eq(tailorings.jobId, jobId));
    } catch { /* budget out or model failure: the field stays empty */ }
    return coverLetter;
  };

  for (const f of fields) {
    const kind = classify(f);
    const r = answerByRule(f, ctx);
    if (r === "no_salary") { noSalary = true; continue; }
    if (r) {
      if (r.file === "cover" && !(await ensureCover())) continue;
      fills.set(f.id, r); continue;
    }
    if (kind === "cover_text") {
      const c = await ensureCover();
      if (c) fills.set(f.id, { id: f.id, label: f.label, value: c, source: "job" });
      continue;
    }
    if (kind === "eeo") continue; // no "decline" option: leave it; a required one stops the plan below
    if (kind !== "why_us") {
      const b = await lookupBank(f.label);
      const v = b == null ? null : matchOption(f, b);
      if (v != null) { fills.set(f.id, { id: f.id, label: f.label, value: v, source: "bank" }); continue; }
    }
    if (f.kind !== "file") open.push(f);
  }

  if (open.length) {
    try {
      const bank = await db.select({ q: answers.question, a: answers.answer }).from(answers);
      const out = await chatJSON<{ answers?: Record<string, unknown> }>({
        model: t.tier === "top" ? TOP_MODEL : MID_MODEL, category: "tailoring", estimateUsd: 0.004, system: DRAFT_SYSTEM,
        user: JSON.stringify({
          profile, savedAnswers: bank,
          job: { title: job.title, company: job.companyName, location: job.location, description: job.descriptionText.slice(0, 4000) },
          fields: open.map((f) => ({ id: f.id, label: f.label, kind: classify(f) === "why_us" ? "why_us" : f.kind, options: f.options })),
        }),
      });
      for (const f of open) {
        const raw = out.answers?.[f.id];
        if (typeof raw !== "string" || !raw.trim()) continue;
        const v = matchOption(f, raw.trim());
        if (v == null) continue;
        fills.set(f.id, { id: f.id, label: f.label, value: v, source: "drafted" });
        if (classify(f) !== "why_us") await saveDrafted(f.label, v);
      }
    } catch { /* budget out or bad output: drafted fields stay empty and the rules below decide */ }
  }

  const list = fields.map((f) => fills.get(f.id)).filter((x): x is Fill => !!x);
  const missing = fields.find((f) => f.required && !fills.has(f.id));
  const [siteRow] = await db.select().from(sites).where(eq(sites.site, a.site));

  let plan: FillPlan;
  if (noSalary) plan = { fills: list, action: "stop", status: "needs_you", reason: "No salary posted" };
  else if (missing) plan = { fills: list, action: "stop", status: "needs_you", reason: `Unknown required field: ${missing.label}` };
  else if (a.site === "linkedin") plan = { fills: list, action: "stop", status: "needs_you", reason: "LinkedIn: review and submit" };
  else if (siteRow && !siteRow.autoSubmit) plan = { fills: list, action: "stop", status: "needs_you", reason: "Auto-submit is off for this site" };
  else if (cfg.trustRemaining > 0 && !a.approved) plan = { fills: list, action: "stop", status: "ready_to_submit", reason: null };
  // An approved job in dry run goes to Needs you, not back to Ready: otherwise it would be handed out again forever.
  else if (cfg.dryRun) plan = { fills: list, action: "stop", status: a.approved ? "needs_you" : "ready_to_submit", reason: "Dry run: filled, not submitted" };
  else plan = { fills: list, action: "submit", status: "applied_pending", reason: null };

  await db.update(applications).set({ fills: list, filledAt: new Date() }).where(eq(applications.jobId, jobId));
  return plan;
}
