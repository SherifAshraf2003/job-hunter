import { readFileSync } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { companies, settings } from "../db/schema";
import { getJson } from "../sources/http";
import { probeSlugs } from "./probe";
import type { BoardRef } from "../sources/types";

type SeedName = { name: string; website?: string; slugs?: string[]; origin: "seed_yc" | "seed_egypt" };

async function probedSet(): Promise<Set<string>> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "probed_names"));
  return new Set((row?.value as string[]) ?? []);
}
async function saveProbed(s: Set<string>) {
  const value = [...s];
  await db.insert(settings).values({ key: "probed_names", value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

export async function addCompanies(refs: (BoardRef & { name: string; origin: "seed_yc" | "seed_egypt" | "harvested" })[]): Promise<number> {
  if (!refs.length) return 0;
  const res = await db.insert(companies).values(refs).onConflictDoNothing().returning({ id: companies.id });
  return res.length;
}

async function seedNames(): Promise<SeedName[]> {
  const egypt = JSON.parse(readFileSync(path.join(process.cwd(), "data/egypt-companies.json"), "utf8")) as { name: string; slugs: string[] }[];
  const yc = await getJson<{ name: string; slug: string; website?: string }[]>("https://yc-oss.github.io/api/companies/hiring.json");
  return [
    ...egypt.map((e) => ({ name: e.name, slugs: e.slugs, origin: "seed_egypt" as const })),
    ...yc.map((c) => ({ name: c.name, website: c.website, slugs: [c.slug], origin: "seed_yc" as const })),
  ];
}

/**
 * Probes seed companies for ATS boards. Resumable: names already probed are skipped,
 * and at most `maxNames` new names are probed per call so a single cycle stays short.
 */
export async function seedCompanies(opts: { maxNames?: number } = {}): Promise<{ added: number; probed: number; remaining: number }> {
  const done = await probedSet();
  const names = (await seedNames()).filter((n) => !done.has(`${n.origin}:${n.name}`));
  const batch = names.slice(0, opts.maxNames ?? 150);
  const limit = pLimit(8);
  let added = 0;
  await Promise.all(batch.map((n) => limit(async () => {
    // Workable rate-limits hard and is mostly used by MENA companies, so only the Egypt list probes it.
    const atsList = n.origin === "seed_egypt" ? undefined : (["greenhouse", "lever", "ashby"] as const).slice();
    const hits = await probeSlugs(n.name, n.website, n.slugs, atsList);
    added += await addCompanies(hits.map((h) => ({ ...h, name: n.name, origin: n.origin })));
    done.add(`${n.origin}:${n.name}`);
  })));
  await saveProbed(done);
  return { added, probed: batch.length, remaining: names.length - batch.length };
}
