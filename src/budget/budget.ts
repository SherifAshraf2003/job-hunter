import { and, gte, lt, eq, sum } from "drizzle-orm";
import { db } from "../db/client";
import { spend } from "../db/schema";
import { loadSettings } from "../config";

export type SpendCategory = "scoring" | "tailoring";

const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const startOfNextMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 1);
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfNextDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

async function total(from: Date, to: Date, category?: SpendCategory): Promise<number> {
  const conds = [gte(spend.at, from), lt(spend.at, to)];
  if (category) conds.push(eq(spend.category, category));
  const [r] = await db.select({ s: sum(spend.usd) }).from(spend).where(and(...conds));
  return Number(r?.s ?? 0);
}

/** True only if spending `estimateUsd` now keeps every cap: monthly total, monthly scoring share, daily scoring. */
export async function canSpend(category: SpendCategory, estimateUsd: number, now: Date = new Date()): Promise<boolean> {
  const cfg = await loadSettings();
  const cap = cfg.budgetUsdMonthly;
  const m0 = startOfMonth(now), m1 = startOfNextMonth(now);
  if ((await total(m0, m1)) + estimateUsd > cap) return false;
  if (category === "scoring") {
    const scoringCap = cap * cfg.scoringShare;
    if ((await total(m0, m1, "scoring")) + estimateUsd > scoringCap) return false;
    if ((await total(startOfDay(now), startOfNextDay(now), "scoring")) + estimateUsd > scoringCap / 30) return false;
  }
  return true;
}

export async function recordSpend(e: {
  category: SpendCategory; provider: "openrouter" | "typesafe"; model: string; usd: number; inputTokens: number; outputTokens: number;
}): Promise<void> {
  await db.insert(spend).values(e);
}

export async function spendSummary(now: Date = new Date()) {
  const cfg = await loadSettings();
  const m0 = startOfMonth(now), m1 = startOfNextMonth(now);
  return {
    todayUsd: await total(startOfDay(now), startOfNextDay(now)),
    monthUsd: await total(m0, m1),
    monthScoringUsd: await total(m0, m1, "scoring"),
    capUsd: cfg.budgetUsdMonthly,
  };
}
