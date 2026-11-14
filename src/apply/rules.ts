import type { BaseProfile } from "../profile/types";
import type { Feasibility, JobRow } from "../scoring/types";
import type { Fill, FormField } from "./types";

export type Kind =
  | "first_name" | "last_name" | "full_name" | "email" | "phone" | "linkedin" | "github" | "website" | "location"
  | "current_company" | "years_experience" | "salary" | "sponsorship" | "work_auth" | "eeo"
  | "resume_file" | "cover_file" | "cover_text" | "why_us" | "other";

export type RuleCtx = { profile: BaseProfile; job: JobRow; canTake: Feasibility; salaryRule: "under_mid" | "under_min" };

const KINDS: [RegExp, Kind][] = [
  [/cover letter/, "cover_text"],
  [/\b(gender|race|racial|ethnicity|ethnic|veteran|disability|disabled|hispanic|latino|latinx|sexual orientation|transgender)\b/, "eeo"],
  [/sponsor/, "sponsorship"],
  [/authori[sz]ed to work|work authori[sz]ation|eligible to work|right to work|legally (able|permitted) to work/, "work_auth"],
  [/salary|compensation|pay expectation|expected pay|desired pay|pay range|rate expectation|expected rate/, "salary"],
  [/why (do you want|are you interested|would you like|us\b|this (role|company|position|team))|what (excites|interests|draws|attracts) you|interest(ed)? in (joining|working)/, "why_us"],
  [/first name|given name|forename/, "first_name"],
  [/last name|surname|family name/, "last_name"],
  [/^(full )?name$|full name|legal name|your name/, "full_name"],
  [/e-?mail/, "email"],
  [/phone|mobile|telephone/, "phone"],
  [/linkedin/, "linkedin"],
  [/github/, "github"],
  [/website|portfolio|personal (site|url|page)/, "website"],
  [/current (company|employer)|most recent (company|employer)/, "current_company"],
  [/years of (professional |relevant |work )?experience|how many years/, "years_experience"],
  [/^(current )?location$|current location|city|where are you (based|located)|country of residence/, "location"],
];

const lower = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** What a field is asking for, from its label and kind. */
export function classify(f: FormField): Kind {
  const l = lower(f.label);
  if (f.kind === "file") return /cover/.test(l) ? "cover_file" : /resume|cv\b|curriculum/.test(l) ? "resume_file" : "other";
  if (/relocat/.test(l)) return "other";
  // "Authorized to work in X without sponsorship?" is an authorization question: Yes would claim a right to work.
  if (/sponsor/.test(l) && /authori[sz]ed|eligible|right to work|legally|permitted to work/.test(l)) return "work_auth";
  for (const [re, k] of KINDS) {
    if (!re.test(l)) continue;
    // Current or past pay isn't the expected-salary rule; "years with React" isn't total years of experience.
    if (k === "salary" && /current|previous|present|last|existing/.test(l)) return "other";
    if (k === "years_experience" && /experience\b.*\b(with|in|using|on)\s+\w|years (with|in|using) /.test(l)) return "other";
    return k;
  }
  return "other";
}

/** Picks the option starting with yes/no, or plain Yes/No for text fields. */
function yesNo(f: FormField, yes: boolean): string | null {
  if (!f.options?.length) return yes ? "Yes" : "No";
  return f.options.find((o) => (yes ? /^\s*yes\b/i : /^\s*no\b/i).test(o)) ?? null;
}

/** Numbers in an option label like "$120k - $140k" or "EGP 50,000+". */
function optionRange(o: string): [number, number] | null {
  const nums = [...o.matchAll(/(\d[\d,.]*)\s*(k|K)?/g)].map((m) => Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1)).filter((n) => !Number.isNaN(n));
  if (!nums.length) return null;
  return [nums[0], nums.length > 1 ? nums[1] : /\+|above|more|over/i.test(o) ? Infinity : nums[0]];
}

const ROUND = { year: 1000, month: 100, hour: 1 } as const;
const PERIOD = { year: "year", month: "month", hour: "hour" } as const;

function salaryFill(f: FormField, c: RuleCtx): Fill | "no_salary" | null {
  const { salaryMin: min, salaryMax: max, salaryCurrency: cur, salaryPeriod: period } = c.job;
  if ((min == null && max == null) || !cur || !period) return "no_salary";
  const base = c.salaryRule === "under_min" ? (min ?? max!) : min != null && max != null ? (min + max) / 2 : (min ?? max!);
  const target = Math.round((base * 0.9) / ROUND[period]) * ROUND[period];
  let value: string | null;
  if (f.kind === "number") value = String(target);
  else if (f.options?.length) {
    const ranged = f.options.map((o) => ({ o, r: optionRange(o) })).filter((x) => x.r);
    value = (ranged.find((x) => target >= x.r![0] && target <= x.r![1])
      ?? ranged.find((x) => x.r![0] >= target)
      ?? ranged[ranged.length - 1])?.o ?? null;
  } else value = `${target.toLocaleString("en-US")} ${cur} per ${PERIOD[period]}`;
  return value == null ? null : { id: f.id, label: f.label, value, source: "rule" };
}

/** Spec section 4: Egypt and remote-from-Egypt contractor roles need no sponsorship; everything else does. */
function needsSponsorship(c: RuleCtx): boolean {
  if (c.job.country === "EG" || c.canTake === "in_egypt") return false;
  if (c.job.remotePolicy === "remote" && c.canTake === "remote_from_egypt") return false;
  return true;
}

const COUNTRY_WORDS = /\b(united states|u\.s\.a?|usa|america|united kingdom|uk|britain|england|canada|germany|france|netherlands|spain|ireland|european union|eu|europe|uae|united arab emirates|saudi|qatar|australia|singapore|india|israel)\b/i;

/** Sherif is authorized to work in Egypt only. */
function authorized(f: FormField, c: RuleCtx): boolean {
  const l = f.label;
  if (/egypt/i.test(l)) return true;
  if (COUNTRY_WORDS.test(l)) return false;
  return c.job.country === "EG";
}

const DECLINE = /decline|prefer not|don't wish|do not wish|not to (say|answer|disclose)|rather not/i;

/**
 * Answers a field from the profile or a fixed rule. Returns null when no rule applies (the bank or a drafted
 * answer may still), and "no_salary" when the form asks for salary but the listing posts none.
 */
export function answerByRule(f: FormField, c: RuleCtx): Fill | "no_salary" | null {
  const p = c.profile;
  const fill = (value: string | null, source: Fill["source"] = "profile"): Fill | null =>
    value == null ? null : { id: f.id, label: f.label, value, source };
  const link = (re: RegExp) => p.links.find((l) => re.test(l)) ?? null;
  const [first, ...rest] = p.name.split(/\s+/);

  switch (classify(f)) {
    case "first_name": return fill(first);
    case "last_name": return fill(rest.join(" ") || null);
    case "full_name": return fill(p.name);
    case "email": return fill(p.links.find((l) => l.includes("@")) ?? null);
    case "linkedin": return fill(link(/linkedin\.com/i));
    case "github": return fill(link(/github\.com/i));
    case "website": return fill(link(/^https?:\/\/(?!.*(linkedin|github)\.com)/i) ?? link(/github\.com/i));
    case "years_experience": {
      const y = p.facts.yearsExperience;
      if (f.kind === "number" || !f.options?.length) return fill(String(y));
      const hit = f.options.find((o) => { const r = optionRange(o); return r && y >= r[0] && y <= r[1]; });
      return fill(hit ?? null);
    }
    case "resume_file": return { id: f.id, label: f.label, value: null, file: "resume", source: "profile" };
    case "cover_file": return { id: f.id, label: f.label, value: null, file: "cover", source: "job" };
    case "salary": return salaryFill(f, c);
    case "sponsorship": return fill(yesNo(f, needsSponsorship(c)), "rule");
    case "work_auth": return fill(yesNo(f, authorized(f, c)), "rule");
    case "eeo": return fill(f.options?.find((o) => DECLINE.test(o)) ?? null, "rule");
    default: return null;
  }
}
