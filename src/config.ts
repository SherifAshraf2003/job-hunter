import "dotenv/config";

export type Weights = { scope: number; company: number; pay: number; level: number; fit: number };

export const config = {
  budgetUsdMonthly: 10,
  scoringShare: 0.5,
  weights: { scope: 0.26, company: 0.2, pay: 0.16, level: 0.1, fit: 0.28 } as Weights,
  cutoff: 60,
  searchIntervalHours: 4,
  tiers: { top: 80, middle: 70, topPerDay: 5 },
  // Phase 3: applying
  trustRemaining: 10,
  dryRun: true,
  globalPause: false,
  caps: { linkedinDaily: 15, perBoardDaily: 3, globalDaily: 60, perCompany30d: 2 },
  salaryRule: "under_mid" as "under_mid" | "under_min",
  pacing: { fieldMs: [400, 1500] as [number, number], betweenAppsSec: [90, 240] as [number, number] },
  extensionToken: "",
  linkedinCollectedAt: null as string | null,
  fxToUsd: { USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, AED: 0.272, SAR: 0.267, EGP: 0.0205, INR: 0.012 } as Record<string, number>,
};

export type Config = typeof config;

/** Defaults overlaid with values saved in the settings table. */
export async function loadSettings(): Promise<Config> {
  const { db } = await import("./db/client");
  const { settings } = await import("./db/schema");
  const rows = await db.select().from(settings);
  const merged: Config = structuredClone(config);
  for (const r of rows) {
    if (r.key in merged) (merged as Record<string, unknown>)[r.key] = r.value;
  }
  return merged;
}

export async function saveSetting(key: keyof Config, value: unknown): Promise<void> {
  const { db } = await import("./db/client");
  const { settings } = await import("./db/schema");
  await db.insert(settings).values({ key, value: value as object })
    .onConflictDoUpdate({ target: settings.key, set: { value: value as object } });
}
