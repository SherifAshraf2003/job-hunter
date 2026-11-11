import { chatJSON } from "../llm/openrouter";
import type { BaseProfile } from "../profile/types";
import type { SourceRef, TailoredResume, TruthIssue } from "./types";
import { MID_MODEL } from "./tiers";

// Canonical ids only: "r0b03" or "p01" would alias real bullets and dodge the duplicate check.
const RB = /^r(0|[1-9]\d*)b(0|[1-9]\d*)$/;
const PR = /^p(0|[1-9]\d*)$/;

/** Base text for a source id: "r{i}b{j}" = role i bullet j, "p{i}" = project i. */
export function sourceText(p: BaseProfile, ref: SourceRef): string | null {
  const rb = ref.match(RB);
  if (rb) return p.roles[+rb[1]]?.bullets[+rb[2]] ?? null;
  const pr = ref.match(PR);
  if (pr) return p.projects[+pr[1]]?.text ?? null;
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

const GENERIC = new Set(["api", "apis", "ui", "ux", "saas", "b2b", "b2c", "ci/cd", "rest", "sdk", "mvp", "kpi", "kpis", "aws", "llm", "llms", "ai", "ml", "ide", "url", "urls", "json", "http", "sql"]);
// Words a headline may use beyond the candidate's real titles and skills. Deliberately excludes specialisms
// (security, data, infrastructure, platform, ...) that would claim a role he never held.
const HEADLINE_WORDS = new Set(["ai", "full-stack", "full", "stack", "product", "products", "founding", "engineer", "software", "developer", "llm", "applications", "agents", "agentic", "web", "and", "&", "-", "|", ",", "with", "for", "of"]);
const NUMBER_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred|hundreds|thousand|thousands|million|millions|billion|billions|dozen|dozens|double|doubled|triple|tripled|half|halved)\b/i;
// After NFKC, only ASCII plus common typographic punctuation is allowed (blocks look-alike letters).
const ALLOWED_CHARS = /^[\x20-\x7E–—‘’“”•]*$/;

const lowerText = (parts: string[]) => parts.join(" \n ").toLowerCase();

function profileText(p: BaseProfile): string {
  return lowerText([
    p.headline, ...p.roles.flatMap((r) => [r.title, r.org, ...r.bullets]),
    ...p.projects.flatMap((x) => [x.name, x.text]), ...Object.entries(p.skills).flatMap(([k, v]) => [k, ...v]),
    ...p.education.flatMap((e) => [e.degree, e.school, ...e.coursework]), ...p.awards.flatMap((a) => [a.name, a.text]),
  ]);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word / whole-phrase match, so "go" doesn't match inside "google" or "ago". */
function knows(known: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRe(term.toLowerCase())}($|[^a-z0-9])`).test(known);
}

const numbers = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));
const stripPunct = (w: string) => w.replace(/^[(\[{`"'“‘*_]+|[)\]}`"'”’*_.,;:!?]+$/g, "");

/**
 * Proper-noun-like terms from the job listing that aren't on the resume (Kubernetes, gRPC, Go...).
 * Only mid-sentence capitalized words and mixed-case/all-caps tokens count, so ordinary words at the start of a sentence don't.
 */
function jobTerms(jobText: string, known: string): Set<string> {
  const out = new Set<string>();
  for (const sentence of jobText.split(/(?<=[.!?:\n])\s+/)) {
    sentence.split(/\s+/).slice(1).forEach((raw) => {
      for (const part of stripPunct(raw).split(/[-/,]/)) {
        const w = stripPunct(part);
        if (w.length < 2 || !/[A-Z]/.test(w)) continue;
        const lw = w.toLowerCase();
        if (!GENERIC.has(lw) && !knows(known, lw)) out.add(lw);
      }
    });
  }
  return out;
}

type Ctx = { known: string; job: Set<string>; otherOrgWords: (roleIdx: number | null) => string[] };

/** Returns why the tailored text isn't supported by its source, or null if it passes the code checks. */
function codeCheck(raw: string, src: string, ctx: Ctx, roleIdx: number | null): string | null {
  const text = raw.normalize("NFKC");
  if (!ALLOWED_CHARS.test(text)) return "contains unusual characters";
  const srcNums = new Set(numbers(src));
  const badNum = numbers(text).find((n) => !srcNums.has(n));
  if (badNum) return `number ${badNum} is not in your original bullet`;
  const nw = text.match(NUMBER_WORDS);
  if (nw && !new RegExp(`\\b${nw[1]}\\b`, "i").test(src)) return `"${nw[1]}" adds a quantity your original bullet doesn't have`;
  for (const org of ctx.otherOrgWords(roleIdx)) {
    if (new RegExp(`\\b${escapeRe(org)}\\b`).test(text) && !src.includes(org)) return `"${org}" belongs to a different job on your resume`;
  }
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = stripPunct(words[i]);
    if (!w) continue;
    const parts = w.split(/[-/]/).map(stripPunct).filter(Boolean);
    for (const part of [w, ...parts]) {
      if (ctx.job.has(part.toLowerCase()) && !knows(ctx.known, part)) return `"${part}" comes from the job listing, not your resume`;
    }
    if (!/[A-Z]/.test(w)) continue;
    // A plainly capitalized first word ("Built", "Shipped") is just sentence case.
    if (i === 0 && /^[A-Z][a-z]+$/.test(w)) continue;
    const lw = w.toLowerCase();
    if (GENERIC.has(lw) || knows(ctx.known, lw)) continue;
    const capParts = parts.filter((x) => /[A-Z]/.test(x));
    if (parts.length > 1 && capParts.every((x) => GENERIC.has(x.toLowerCase()) || knows(ctx.known, x))) continue;
    return `"${w}" doesn't appear anywhere in your resume`;
  }
  return null;
}

/** Turns the claim checker's reply into the list of ids to revert. Anything without an explicit "ok" is unsupported. */
export function parseVerdicts(out: unknown, ids: string[]): string[] {
  const v = (out as { verdicts?: unknown })?.verdicts;
  if (!v || typeof v !== "object" || Array.isArray(v)) return [...ids];
  const norm = new Map(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.trim().toLowerCase(), String(x).trim().toLowerCase()]));
  return ids.filter((id) => norm.get(id.toLowerCase()) !== "ok");
}

async function defaultClaimCheck(r: TailoredResume, p: BaseProfile): Promise<SourceRef[]> {
  const pairs = [...r.roles.flatMap((x) => x.bullets), ...r.projects]
    .map((b) => ({ id: b.source, original: sourceText(p, b.source), tailored: b.text }))
    .filter((x) => x.original && x.original !== x.tailored);
  if (r.headline !== p.headline) {
    pairs.push({ id: "headline", original: `Real titles: ${[p.headline, ...p.roles.map((x) => x.title)].join("; ")}`, tailored: r.headline });
  }
  if (!pairs.length) return [];
  const out = await chatJSON<unknown>({
    model: MID_MODEL, category: "tailoring", estimateUsd: 0.002,
    system: `You audit resume text for honesty. Each item has an "original" (the candidate's real bullet, or his real titles for the headline) and a "tailored" rewrite.
Mark a rewrite "unsupported" if it claims anything the original doesn't support: bigger scope, a role or title he didn't hold, seniority, a team size, a technology, an outcome, or a number.
Rephrasing, reordering, and equivalent wording are "ok".
Return JSON {"verdicts": {"<id>": "ok" | "unsupported", ...}} with a verdict for EVERY id.`,
    user: JSON.stringify(pairs),
  });
  return parseVerdicts(out, pairs.map((x) => x.id));
}

/**
 * Enforces "never invent experience". Bullets must come from their own role (projects from projects), add no numbers,
 * names, tools, or quantities, and survive a second model's claim check. Failing bullets revert to the original wording;
 * misplaced or unknown items, unknown skills, and unknown skill categories are dropped; a bad headline reverts.
 */
export async function truthCheck(
  r: TailoredResume, p: BaseProfile, _model: string,
  claimCheck: (r: TailoredResume, p: BaseProfile) => Promise<SourceRef[]> = defaultClaimCheck,
  jobText = "",
): Promise<{ resume: TailoredResume; issues: TruthIssue[] }> {
  const issues: TruthIssue[] = [];
  const known = profileText(p);
  const orgWords = p.roles.map((role) => role.org.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 2 && /^[A-Z]/.test(w)));
  const ctx: Ctx = {
    known,
    job: jobTerms(jobText, known),
    otherOrgWords: (roleIdx) => orgWords.flatMap((ws, i) => (i === roleIdx ? [] : ws))
      .filter((w) => roleIdx == null || !orgWords[roleIdx].includes(w)),
  };
  const out: TailoredResume = structuredClone(r);
  const seen = new Set<string>();

  const fixItem = <T extends { source: SourceRef; text: string }>(b: T, roleIdx: number | null): T | null => {
    const m = roleIdx == null ? b.source.match(PR) : b.source.match(RB);
    if (!m || (roleIdx != null && Number(m[1]) !== roleIdx) || sourceText(p, b.source) == null) {
      issues.push({ where: b.source, problem: roleIdx == null ? "isn't one of your projects" : "belongs to a different job on your resume, or doesn't exist", action: "dropped" });
      return null;
    }
    if (seen.has(b.source)) { issues.push({ where: b.source, problem: "used the same original bullet twice", action: "dropped" }); return null; }
    seen.add(b.source);
    const src = sourceText(p, b.source)!;
    const why = codeCheck(b.text, src, ctx, roleIdx);
    if (why) { issues.push({ where: b.source, problem: why, action: "reverted" }); return { ...b, text: src }; }
    return { ...b, text: b.text.normalize("NFKC") };
  };

  const rolesSeen = new Set<number>();
  out.roles = out.roles
    .filter((role) => Number.isInteger(role.roleIdx) && p.roles[role.roleIdx] && !rolesSeen.has(role.roleIdx) && rolesSeen.add(role.roleIdx))
    .map((role) => ({ ...role, bullets: role.bullets.map((b) => fixItem(b, role.roleIdx)).filter((b): b is NonNullable<typeof b> => b !== null) }));
  out.projects = out.projects.map((b) => fixItem(b, null)).filter((b): b is NonNullable<typeof b> => b !== null);

  // Skills: categories must be the resume's own; items must be real skills.
  const baseCats = new Map(Object.keys(p.skills).map((c) => [c.toLowerCase().trim(), c]));
  const baseSkills = new Set(Object.values(p.skills).flat().map((s) => s.toLowerCase()));
  out.skills = out.skills.flatMap((cat) => {
    const real = baseCats.get(String(cat.category).toLowerCase().trim());
    if (!real) { issues.push({ where: "skills", problem: `category "${cat.category}" isn't on your resume`, action: "dropped" }); return []; }
    const items = cat.items.filter((it) => {
      const ok = baseSkills.has(String(it).toLowerCase()) || (ALLOWED_CHARS.test(it) && knows(known, it) && !ctx.job.has(it.toLowerCase()));
      if (!ok) issues.push({ where: "skills", problem: `skill "${it}" isn't on your resume`, action: "dropped" });
      return ok;
    });
    return items.length ? [{ category: real, items }] : [];
  });

  // Headline: only words from his real titles, headline, and skills, plus a few generic ones; no numbers.
  const headlineVocab = new Set(lowerText([p.headline, ...p.roles.map((x) => x.title), ...Object.values(p.skills).flat()]).split(/[^a-z0-9+.#&-]+/).filter(Boolean));
  const ok = (w: string) => headlineVocab.has(w) || HEADLINE_WORDS.has(w) || (w.endsWith("s") && (headlineVocab.has(w.slice(0, -1)) || HEADLINE_WORDS.has(w.slice(0, -1))));
  const h = out.headline.normalize("NFKC");
  const bad = !ALLOWED_CHARS.test(h) || /\d/.test(h) ? h : h.toLowerCase().split(/[\s/()]+/).map((w) => w.replace(/[,.;:]+$/, "")).find((w) => w && !ok(w));
  if (bad) { issues.push({ where: "headline", problem: `"${bad}" isn't supported by your resume`, action: "reverted" }); out.headline = p.headline; }

  // Second opinion from a model on claims code can't catch (scope inflation, implied outcomes, titles).
  let flagged: Set<string>;
  try {
    flagged = new Set(await claimCheck(out, p));
  } catch (e) {
    if ((e as Error).name === "BudgetExceededError") throw e;
    flagged = new Set([...out.roles.flatMap((x) => x.bullets), ...out.projects].map((b) => b.source).concat("headline"));
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
  if (flagged.has("headline") && out.headline !== p.headline) {
    issues.push({ where: "headline", problem: "claims a title you don't hold", action: "reverted" });
    out.headline = p.headline;
  }
  return { resume: out, issues };
}
