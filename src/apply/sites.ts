import { extractBoardRef } from "../discovery/boardRefs";
import type { Site } from "./types";

const SITE_PATTERNS: [RegExp, Site][] = [
  [/^https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\//i, "greenhouse"],
  [/^https?:\/\/jobs(?:\.eu)?\.lever\.co\//i, "lever"],
  [/^https?:\/\/jobs\.ashbyhq\.com\//i, "ashby"],
  [/^https?:\/\/(?:apply\.workable\.com|[a-z0-9-]+\.workable\.com)\//i, "workable"],
  [/^https?:\/\/(?:[a-z]+\.)?linkedin\.com\/jobs\//i, "linkedin"],
];

/** Which apply flow a URL belongs to. Anything unrecognized is "other" (applied to by hand). */
export function siteOf(url: string): Site {
  for (const [re, site] of SITE_PATTERNS) if (re.test(url)) return site;
  return "other";
}

/** Caps key: one per ATS company board, one for all of LinkedIn. */
export function boardKey(url: string): string {
  const site = siteOf(url);
  if (site === "linkedin") return "linkedin";
  const embedFor = site === "greenhouse" ? new URL(url).searchParams.get("for") : null;
  if (embedFor) return `greenhouse:${embedFor}`;
  const ref = extractBoardRef(url);
  return ref ? `${ref.ats}:${ref.slug}` : `${site}:${new URL(url).hostname}`;
}

const RANK: Record<Site, number> = { greenhouse: 0, lever: 0, ashby: 0, workable: 0, linkedin: 1, other: 2 };

/** Picks where to apply: the company's own ATS beats LinkedIn, which beats anything else (spec 6.1). */
export function pickApplyTarget(
  job: { applyUrl: string },
  sources: { source: string; url: string; boardSlug?: string | null; externalId?: string | null }[],
): { url: string; site: Site; boardKey: string } {
  // Companies like Stripe host their Greenhouse board on their own careers page; Greenhouse's embed form still works.
  const embeds = sources.filter((s) => s.source === "greenhouse" && s.boardSlug && s.externalId && siteOf(s.url) !== "greenhouse")
    .map((s) => `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(s.boardSlug!)}&token=${encodeURIComponent(s.externalId!)}`);
  const urls = [job.applyUrl, ...sources.map((s) => s.url), ...embeds].filter((u) => /^https?:\/\//.test(u));
  const best = urls.map((url) => ({ url, site: siteOf(url) })).sort((a, b) => RANK[a.site] - RANK[b.site])[0]
    ?? { url: job.applyUrl, site: "other" as Site };
  return { ...best, boardKey: boardKey(best.url) };
}
