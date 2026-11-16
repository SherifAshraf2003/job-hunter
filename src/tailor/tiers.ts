import "dotenv/config";
import type { Config } from "../config";
import type { Tier, Treatment } from "./types";

export const TOP_MODEL = process.env.OPENROUTER_TOP_MODEL || "anthropic/claude-haiku-5.5";
export const MID_MODEL = process.env.OPENROUTER_MID_MODEL || "anthropic/claude-haiku-5.5";

/** Best composite first: top until today's top-tier limit is used, then middle/bottom by threshold. */
export function assignTiers(list: { id: number; composite: number }[], cfg: Config, topUsedToday: number): Map<number, Tier> {
  const out = new Map<number, Tier>();
  let topLeft = Math.max(0, cfg.tiers.topPerDay - topUsedToday);
  for (const j of [...list].sort((a, b) => b.composite - a.composite)) {
    if (j.composite >= cfg.tiers.top && topLeft > 0) { out.set(j.id, "top"); topLeft--; }
    else if (j.composite >= cfg.tiers.middle) out.set(j.id, "middle");
    else out.set(j.id, "bottom");
  }
  return out;
}

/** Model and rewrite depth for a tier, degraded as month-to-date spend approaches the cap (spec section 7). */
export function pickTreatment(tier: Tier, monthSpendRatio: number): Treatment {
  // Every tier gets a full rewrite (about $0.02): a light one barely changed the resume. Only near the cap does it fall back.
  if (monthSpendRatio >= 0.9) return { tier, resumeModel: MID_MODEL, extrasModel: MID_MODEL, rewrite: "reorder" };
  return { tier, resumeModel: tier === "top" ? TOP_MODEL : MID_MODEL, extrasModel: MID_MODEL, rewrite: "full" };
}

/** Upper-bound cost of one job's tailoring (resume + cover letter + claim check), used for the budget check. */
export function estimateUsd(t: Treatment): number {
  const resume = t.rewrite === "full" ? 0.02 : 0.003;
  return resume + 0.003 + 0.002;
}
