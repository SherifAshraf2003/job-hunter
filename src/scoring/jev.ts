import { TypeSafeClient, score, choice } from "@typesafe-ai/sdk";
import { canSpend, recordSpend } from "../budget/budget";
import { BudgetExceededError } from "../llm/openrouter";
import { buildScoringState } from "./state";
import type { DimensionScores, Feasibility, Scorer } from "./types";

const questions = {
  scope: score(
    "How much of this job (`job`) is the kind of work the candidate wants: building AI/LLM-powered products, founding-engineer work, or full-stack product engineering?",
    [
      "No software engineering work, or software is incidental to the role",
      "Software engineering, but narrow or far from product work (e.g. pure infrastructure, embedded, data pipelines only)",
      "General software or web product engineering with little AI involvement",
      "Full-stack product engineering with meaningful AI/LLM features, or an early-stage startup engineering role",
      "Core AI/LLM product engineering, or a founding/first engineer role building the product",
    ],
  ),
  company: score(
    "Based only on what the listing (`job`) reveals, how strong does the hiring company look as an employer?",
    [
      "No information, or warning signs (vague company, agency reselling candidates, unclear product)",
      "Small or unknown company with little evidence of traction",
      "Real company with a clear product and some traction or funding",
      "Well-funded or clearly growing company with a strong product (e.g. notable investors, known customers)",
      "Top-tier or category-leading company, or a startup backed by top investors with strong momentum",
    ],
  ),
  pay: score(
    "How good is the posted pay (`job.salary`) compared with typical pay for this role in the job's own local market (the job's country, or the hiring company's market for remote roles)? If the salary is not posted, answer level 1.",
    [
      "Well below the local market for this role",
      "Below market, or salary not posted",
      "Around the local market rate",
      "Above the local market rate",
      "Top of the local market for this role",
    ],
  ),
  level: score(
    "How well does the seniority this job asks for match the candidate (`candidate`): about 2 years of professional experience including two founding-engineer roles?",
    [
      "Far off: needs many more years (senior/staff, 6+ years) or is an internship/entry-level role far below him",
      "Somewhat too senior (asks for 5+ years) or clearly junior-only",
      "Stretch but plausible (asks for 3–5 years) or a junior role he'd be over-qualified for",
      "Good match: mid-level, or open to 2–4 years",
      "Exact match: mid-level, founding/early engineer, or explicitly open to strong early-career engineers",
    ],
  ),
  fit: score(
    "How well does the candidate's real, shipped experience (`candidate.roles`, `candidate.projects`, `candidate.skills`) match what this job (`job.description`) requires?",
    [
      "Requires core skills he does not have at all",
      "Matches a few requirements but misses several core ones",
      "Matches about half of the core requirements",
      "Matches most core requirements with directly relevant shipped work",
      "His shipped work maps directly onto nearly every requirement",
    ],
  ),
  canTake: choice(
    "Can the candidate (`candidate.citizenship`: Egyptian citizen living in Egypt, willing to relocate per `candidate.relocation`) actually take this job (`job`)?",
    {
      in_egypt: "The job is located in Egypt (on-site or hybrid in Egypt), so no visa is needed",
      remote_from_egypt: "The job is remote and open to people working from Egypt (worldwide, EMEA, Africa/MENA, or no location restriction)",
      sponsors: "The job is outside Egypt and he can get there: on-site or hybrid in a Gulf (GCC) country or an EU country and the listing does not rule out visa sponsorship, or anywhere else (including the UK, which is not in the EU) only where the listing explicitly says they sponsor visas or relocate people",
      unclear: "Not enough information to tell whether someone in Egypt can take it",
      not_possible: "Restricted to a region excluding Egypt and not a Gulf or EU relocation he can make (e.g. US-only remote, on-site in the US or UK unless the listing explicitly offers sponsorship, must already have work authorization, or explicitly no sponsorship)",
    },
  ),
} as const;

const norm = (s: number) => Math.round((s / 4) * 1000) / 10;

export function makeJevScorer(): Scorer {
  const client = new TypeSafeClient();
  const pin = Number(process.env.JEV_USD_PER_MTOK_INPUT ?? "0.042");
  const pout = Number(process.env.JEV_USD_PER_MTOK_OUTPUT ?? "0");
  const estimate = 0.0003;
  return {
    engine: "jev",
    estimateUsd: () => estimate,
    async score(job, profile): Promise<DimensionScores> {
      if (!(await canSpend("scoring", estimate))) throw new BudgetExceededError("scoring");
      const res = await client.systemOne({ state: buildScoringState(job, profile), questions });
      const inTok = res.usage?.input_tokens, outTok = res.usage?.output_tokens;
      // If usage isn't reported, charge the estimate so the budget cap still holds.
      const usd = inTok == null ? estimate : Math.max((inTok * pin + (outTok ?? 0) * pout) / 1e6, 0);
      await recordSpend({
        category: "scoring", provider: "typesafe", model: res.model,
        usd, inputTokens: inTok ?? 0, outputTokens: outTok ?? 0,
      });
      const a = res.answers;
      return {
        scope: norm(a.scope.score), company: norm(a.company.score), pay: norm(a.pay.score),
        level: norm(a.level.score), fit: norm(a.fit.score),
        canTake: a.canTake.choice as Feasibility, canTakeConfidence: a.canTake.confidence,
        raw: a,
      };
    },
  };
}
