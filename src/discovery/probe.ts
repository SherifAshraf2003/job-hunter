import { fetchBoard } from "../sources/boards";
import type { Ats, BoardRef } from "../sources/types";

const ATS: Ats[] = ["greenhouse", "lever", "ashby", "workable"];

export function slugCandidates(name: string, website?: string, extra: string[] = []): string[] {
  const base = name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9\s-]/g, "").trim();
  const c = new Set<string>(extra.map((s) => s.toLowerCase()));
  c.add(base.replace(/[\s-]+/g, ""));
  c.add(base.replace(/\s+/g, "-"));
  if (website) {
    const host = website.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
    const stem = host.split(".")[0];
    if (stem) c.add(stem.toLowerCase());
  }
  return [...c].filter((s) => s.length >= 2);
}

/** Tries each candidate slug on each ATS; a board that answers with at least one job is a hit. */
export async function probeSlugs(name: string, website?: string, extra: string[] = []): Promise<BoardRef[]> {
  const hits: BoardRef[] = [];
  for (const ats of ATS) {
    for (const slug of slugCandidates(name, website, extra)) {
      try {
        const jobs = await fetchBoard({ ats, slug });
        if (jobs.length > 0) { hits.push({ ats, slug }); break; }
      } catch { /* 404 or network: not a hit */ }
    }
  }
  return hits;
}
