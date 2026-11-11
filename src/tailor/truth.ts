import { chatJSON } from "../llm/openrouter";
import type { BaseProfile } from "../profile/types";
import type { SourceRef, TailoredResume, TruthIssue } from "./types";
import { MID_MODEL } from "./tiers";

/** Base text for a source id: "r{i}b{j}" = role i bullet j, "p{i}" = project i (name and text). */
export function sourceText(p: BaseProfile, ref: SourceRef): string | null {
  const rb = ref.match(/^r(\d+)b(\d+)$/);
  if (rb) return p.roles[+rb[1]]?.bullets[+rb[2]] ?? null;
  const pr = ref.match(/^p(\d+)$/);
  if (pr) { const x = p.projects[+pr[1]]; return x ? x.text : null; }
  return null;
}

/** The untailored resume expressed as a TailoredResume (used for "keywords" mode, reverts, and tests). */
export function baseResume(p: BaseProfile): TailoredResume {
  return {
    headline: p.headline,
    roles: p.roles.map((r, i) => ({ roleIdx: i, bullets: r.bullets.map((text, j) => ({ text, source: `r${i}b${j}` })) })),
    projects: p.projects.map((x, i) => ({ source: `p${i}`, text: x.text })),
    skills: Object.entries(p.skills).map(([category, items]) => ({ category, items: [...items] })),
    includeQuote: Boolean(p.quote),
  };
}

const GENERIC = new Set(["api", "apis", "ui", "ux", "saas", "b2b", "b2c", "ci/cd", "rest", "sdk", "mvp", "kpi", "kpis", "aws", "llm", "llms", "ai", "ml", "ide"]);
const HEADLINE_WORDS = ["ai", "full-stack", "full", "stack", "product", "founding", "engineer", "software", "llm", "backend", "frontend", "developer", "platform", "applications", "agents", "agentic", "systems", "engineering", "web", "and", "&", "/", "-", "|", ","];

function profileText(p: BaseProfile): string {
  return [
    p.headline, ...p.roles.flatMap((r) => [r.title, r.org, ...r.bullets]),
    ...p.projects.flatMap((x) => [x.name, x.text]), ...Object.entries(p.skills).flatMap(([k, v]) => [k, ...v]),
    ...p.education.flatMap((e) => [e.degree, e.school, ...e.coursework]), ...p.awards.flatMap((a) => [a.name, a.text]),
  ].join(" \n ").toLowerCase();
}

/** Whole-word / whole-phrase match, so "go" doesn't match inside "google" or "ago". */
function knows(known: string, term: string): boolean {
  const t = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${t}($|[^a-z0-9])`).test(known);
}

const numbers = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));

/** Returns a reason the tailored text isn't supported by its source, or null if it passes the code checks. */
function codeCheck(text: string, src: string, known: string): string | null {
  const srcNums = new Set(numbers(src));
  const badNum = numbers(text).find((n) => !srcNums.has(n));
  if (badNum) return `number ${badNum} is not in your original bullet`;
  const words = text.split(/\s+/).slice(1);
  for (const raw of words) {
    const w = raw.replace(/^[("'“]+|[)"'”.,;:!?]+$/g, "");
    if (!/^[A-Z]/.test(w)) continue;
    const lw = w.toLowerCase();
    if (GENERIC.has(lw) || knows(known, lw)) continue;
    // "Redis-backed", "TypeScript/Node.js": every capitalized part must be known.
    const parts = w.split(/[-/]/).filter((x) => /^[A-Z]/.test(x));
    if (parts.length && parts.join("") !== w && parts.every((x) => GENERIC.has(x.toLowerCase()) || knows(known, x))) continue;
    return `"${w}" doesn't appear anywhere in your resume`;
  }
  return null;
}

async function defaultClaimCheck(r: TailoredResume, p: BaseProfile): Promise<SourceRef[]> {
  const pairs = [...r.roles.flatMap((x) => x.bullets), ...r.projects]
    .map((b) => ({ source: b.source, original: sourceText(p, b.source), tailored: b.text }))
    .filter((x) => x.original && x.original !== x.tailored);
  if (!pairs.length) return [];
  const out = await chatJSON<{ unsupported?: string[] }>({
    model: MID_MODEL, category: "tailoring", estimateUsd: 0.002,
    system: `You audit resume bullets for honesty. Each item has an "original" (the candidate's real bullet) and a "tailored" rewrite.
Flag a rewrite if it claims anything the original doesn't support: a bigger scope, a role or title, a team size, a technology, an outcome, or a number not in the original.
Rephrasing, reordering, and using different but equivalent words is fine.
Return JSON {"unsupported": [source ids of flagged items]}.`,
    user: JSON.stringify(pairs),
  });
  return Array.isArray(out.unsupported) ? out.unsupported.filter((s) => typeof s === "string") : [];
}

/**
 * Enforces "never invent experience": every bullet must trace to a real source and add no numbers, names, or tools.
 * Failing bullets revert to the original wording; unknown sources and skills are dropped.
 */
export async function truthCheck(
  r: TailoredResume, p: BaseProfile, _model: string,
  claimCheck: (r: TailoredResume, p: BaseProfile) => Promise<SourceRef[]> = defaultClaimCheck,
): Promise<{ resume: TailoredResume; issues: TruthIssue[] }> {
  const issues: TruthIssue[] = [];
  const known = profileText(p);
  const out: TailoredResume = structuredClone(r);

  const fixItem = <T extends { source: SourceRef; text: string }>(b: T): T | null => {
    const src = sourceText(p, b.source);
    if (src == null) { issues.push({ where: b.source, problem: "points to a bullet that doesn't exist", action: "dropped" }); return null; }
    const why = codeCheck(b.text, src, known);
    if (why) { issues.push({ where: b.source, problem: why, action: "reverted" }); return { ...b, text: src }; }
    return b;
  };

  // A source may be used once; later duplicates are dropped.
  const seen = new Set<string>();
  const firstUse = <T extends { source: SourceRef }>(b: T) => {
    if (!seen.has(b.source)) { seen.add(b.source); return true; }
    issues.push({ where: b.source, problem: "used the same original bullet twice", action: "dropped" });
    return false;
  };
  out.roles = out.roles.map((role) => ({ ...role, bullets: role.bullets.filter(firstUse) }));
  out.projects = out.projects.filter(firstUse);

  out.roles = out.roles
    .filter((role) => p.roles[role.roleIdx])
    .map((role) => ({ ...role, bullets: role.bullets.map(fixItem).filter((b): b is NonNullable<typeof b> => b !== null) }));
  out.projects = out.projects.map(fixItem).filter((b): b is NonNullable<typeof b> => b !== null);

  const baseSkills = new Set(Object.values(p.skills).flat().map((s) => s.toLowerCase()));
  out.skills = out.skills.map((cat) => ({
    ...cat,
    items: cat.items.filter((it) => {
      const ok = baseSkills.has(it.toLowerCase()) || knows(known, it);
      if (!ok) issues.push({ where: "skills", problem: `skill "${it}" isn't on your resume`, action: "dropped" });
      return ok;
    }),
  })).filter((c) => c.items.length);

  const allowed = new Set([...known.split(/[^a-z0-9+.#/&-]+/), ...HEADLINE_WORDS]);
  const ok = (w: string) => allowed.has(w) || (w.endsWith("s") && allowed.has(w.slice(0, -1)));
  const badHeadline = out.headline.toLowerCase().split(/[\s/()]+/).map((w) => w.replace(/[,.;:]+$/, "")).find((w) => w && !ok(w));
  if (badHeadline) {
    issues.push({ where: "headline", problem: `"${badHeadline}" isn't supported by your resume`, action: "reverted" });
    out.headline = p.headline;
  }

  // Second opinion from a model on claims code can't catch (scope inflation, implied outcomes).
  let flagged: Set<string>;
  try {
    flagged = new Set(await claimCheck(out, p));
  } catch (e) {
    // Can't double-check: be safe and keep only original wording.
    if ((e as Error).name === "BudgetExceededError") throw e;
    flagged = new Set([...out.roles.flatMap((x) => x.bullets), ...out.projects].map((b) => b.source));
    issues.push({ where: "all", problem: `couldn't double-check rewrites (${(e as Error).message.slice(0, 80)}), so original wording was kept`, action: "reverted" });
  }
  const revert = <T extends { source: SourceRef; text: string }>(b: T): T => {
    const src = sourceText(p, b.source)!;
    if (!flagged.has(b.source) || b.text === src) return b;
    issues.push({ where: b.source, problem: "claims something your original bullet doesn't support", action: "reverted" });
    return { ...b, text: src };
  };
  out.roles = out.roles.map((role) => ({ ...role, bullets: role.bullets.map(revert) }));
  out.projects = out.projects.map(revert);

  return { resume: out, issues };
}
