import "dotenv/config";
import type { Config } from "../config";
import type { Tier, Treatment } from "./types";

export const TOP_MODEL = process.env.OPENROUTER_TOP_MODEL || "anthropic/claude-sonnet-5.5";
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
  const effective: Tier = monthSpendRatio >= 0.9 ? "bottom" : monthSpendRatio >= 0.7 && tier === "top" ? "middle" : tier;
  if (effective === "top") return { tier, resumeModel: TOP_MODEL, extrasModel: MID_MODEL, rewrite: "full" };
  if (effective === "middle") return { tier, resumeModel: MID_MODEL, extrasModel: MID_MODEL, rewrite: "reorder" };
  return { tier, resumeModel: MID_MODEL, extrasModel: MID_MODEL, rewrite: "keywords" };
}

/** Upper-bound cost of one job's tailoring (resume + extras + claim check), used for the budget check. */
export function estimateUsd(t: Treatment): number {
  const resume = t.resumeModel === TOP_MODEL ? 0.05 : 0.003;
  return resume + 0.003 + 0.002;
}
