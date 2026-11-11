import { chatJSON } from "../llm/openrouter";
import type { BaseProfile } from "../profile/types";
import type { JobRow } from "../scoring/types";
import type { GapItem, Prep, TailoredResume, Treatment } from "./types";
import { baseResume } from "./truth";
import { TOP_MODEL } from "./tiers";

const RULES = `Hard rules (never break these):
- Use ONLY facts from the candidate's resume. Never add employers, titles, dates, numbers, team sizes, outcomes, tools, or skills that aren't in the source bullet.
- Every bullet must keep the "source" id of the original bullet it comes from. Never merge two sources into one bullet.
- You may rephrase into the job's vocabulary, reorder, and drop weaker bullets, but every role keeps at least 2 bullets.
- Skills may only be reordered or dropped, never added.
- For projects, "text" is the description only; don't repeat the project name.`;

function profileForPrompt(p: BaseProfile) {
  return {
    headline: p.headline,
    roles: p.roles.map((r, i) => ({ roleIdx: i, title: r.title, org: r.org, dates: r.dates, bullets: r.bullets.map((text, j) => ({ source: `r${i}b${j}`, text })) })),
    projects: p.projects.map((x, i) => ({ source: `p${i}`, name: x.name, text: x.text })),
    skills: p.skills,
  };
}

function jobForPrompt(job: JobRow) {
  return { title: job.title, company: job.companyName, location: job.location, description: job.descriptionText.slice(0, 7000) };
}

const MODE: Record<Treatment["rewrite"], string> = {
  full: `Tailor fully. Actually rewrite the bullets you keep; returning them word for word is a failure.
- Lead each bullet with what this job cares about, and use the job's own terms wherever they truthfully describe the same work (e.g. call the voice agent an "AI agent" for an agents role, or name TypeScript/Node.js when the source bullet or that role's stack includes them).
- Keep the meaning, and keep every number exactly as written.
- Put the most relevant bullets first and drop the least relevant ones.
- Choose a headline that fits the job, using only titles the candidate actually holds (e.g. "Founding Engineer, AI Products").
- Order skills by relevance.
Example. Source: "Built backend services for asynchronous processing using Redis, job queues, and background jobs." For a job about reliable agent pipelines, write: "Built Redis-backed job queues and background workers for asynchronous processing, keeping long-running tasks off the request path."`,
  reorder: "Tailor lightly: reorder bullets and skills by relevance to the job, with only small wording changes to match the job's keywords. Keep the headline close to the original.",
  keywords: "Do not change bullets. Only adjust the headline (using only titles the candidate actually has) and the order of skills.",
};

/** Keeps every role present with at least 2 bullets, refilling from the base in original order. */
function ensureRoles(r: TailoredResume, p: BaseProfile): TailoredResume {
  const base = baseResume(p);
  const roles = base.roles.map((b) => {
    const got = r.roles.find((x) => x.roleIdx === b.roleIdx)?.bullets ?? [];
    const bullets = [...got];
    for (const extra of b.bullets) {
      if (bullets.length >= Math.min(2, b.bullets.length)) break;
      if (!bullets.some((x) => x.source === extra.source)) bullets.push(extra);
    }
    return { roleIdx: b.roleIdx, bullets };
  });
  return { ...r, roles };
}

export async function generateResume(job: JobRow, profile: BaseProfile, t: Treatment): Promise<TailoredResume> {
  const base = baseResume(profile);
  if (!t.resumeModel) return base;
  const out = await chatJSON<Partial<TailoredResume>>({
    model: t.resumeModel, category: "tailoring", estimateUsd: t.resumeModel === TOP_MODEL ? 0.05 : 0.003,
    system: `You tailor a software engineer's one-page resume to a specific job.\n${MODE[t.rewrite]}\n\n${RULES}\n
Return JSON: {"headline": string, "roles": [{"roleIdx": number, "bullets": [{"source": string, "text": string}]}], "projects": [{"source": string, "text": string}], "skills": [{"category": string, "items": string[]}], "includeQuote": boolean}`,
    user: JSON.stringify({ job: jobForPrompt(job), resume: profileForPrompt(profile) }),
  });
  const r: TailoredResume = {
    headline: typeof out.headline === "string" && out.headline.trim() ? out.headline.trim() : base.headline,
    roles: Array.isArray(out.roles) ? out.roles.filter((x) => typeof x?.roleIdx === "number" && Array.isArray(x.bullets))
      .map((x) => ({ roleIdx: x.roleIdx, bullets: x.bullets.filter((b) => typeof b?.text === "string" && typeof b?.source === "string") })) : base.roles,
    projects: Array.isArray(out.projects) ? out.projects.filter((b) => typeof b?.text === "string" && typeof b?.source === "string") : base.projects,
    skills: Array.isArray(out.skills) ? out.skills.filter((c) => typeof c?.category === "string" && Array.isArray(c.items)) : base.skills,
    includeQuote: typeof out.includeQuote === "boolean" ? out.includeQuote : base.includeQuote,
  };
  // Models sometimes prefix the project name ("LeadMate: ..."); the name is rendered separately.
  r.projects = r.projects.map((x) => {
    const name = profile.projects[Number(x.source.slice(1))]?.name;
    return name && x.text.startsWith(name) ? { ...x, text: x.text.slice(name.length).replace(/^\s*[:\u2013\u2014-]\s*/, "") } : x;
  });
  // In keywords mode bullets stay exactly as written; only the headline and skill order come from the model.
  if (t.rewrite === "keywords") return { ...base, headline: r.headline, skills: r.skills.length ? r.skills : base.skills };
  return ensureRoles(r, profile);
}

export async function generateExtras(job: JobRow, profile: BaseProfile, t: Treatment, wantsCoverLetter: boolean): Promise<{ gapReport: GapItem[]; prep: Prep; coverLetter: string | null }> {
  const out = await chatJSON<{ gapReport?: GapItem[]; prep?: Prep; coverLetter?: string | null }>({
    model: t.extrasModel, category: "tailoring", estimateUsd: 0.003,
    system: `You help a software engineer prepare for one job application. Use only facts from his resume; never invent experience.
Return JSON:
{"gapReport": [{"requirement": string, "importance": "core"|"nice", "suggestion": string}],   // up to 6 requirements the job asks for that the resume doesn't show. For "core" ones, suggest a concrete 1-2 day side project that would make it true; for "nice" ones, a one-line way to address it.
 "prep": {"questions": [{"question": string, "why": string}], "companyNotes": string[]},       // up to 6 interview questions likely from what his resume emphasizes for this job, and up to 3 short notes about the company taken from the listing (stage, product, team)
 "coverLetter": ${wantsCoverLetter ? "string  // under 220 words, specific to this job, plain and direct, only real facts" : "null"}}`,
    user: JSON.stringify({ job: jobForPrompt(job), resume: profileForPrompt(profile) }),
  });
  const gap = Array.isArray(out.gapReport) ? out.gapReport.filter((g) => g && typeof g.requirement === "string").slice(0, 6)
    .map((g) => ({ requirement: g.requirement, importance: g.importance === "core" ? "core" as const : "nice" as const, suggestion: String(g.suggestion ?? "") })) : [];
  const q = Array.isArray(out.prep?.questions) ? out.prep!.questions.filter((x) => x && typeof x.question === "string").slice(0, 6) : [];
  const notes = Array.isArray(out.prep?.companyNotes) ? out.prep!.companyNotes.filter((x) => typeof x === "string").slice(0, 3) : [];
  return {
    gapReport: gap,
    prep: { questions: q.map((x) => ({ question: x.question, why: String(x.why ?? "") })), companyNotes: notes },
    coverLetter: wantsCoverLetter && typeof out.coverLetter === "string" && out.coverLetter.trim() ? out.coverLetter.trim() : null,
  };
}

/** Spec: cover letters only when the listing asks for one. */
export const wantsCoverLetter = (job: JobRow) => /cover letter/i.test(job.descriptionText);
