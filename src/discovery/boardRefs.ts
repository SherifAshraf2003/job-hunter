import type { BoardRef } from "../sources/types";

const PATTERNS: [RegExp, BoardRef["ats"]][] = [
  [/^https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i, "greenhouse"],
  [/^https?:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i, "greenhouse"],
  [/^https?:\/\/jobs(?:\.eu)?\.lever\.co\/([a-z0-9_.-]+)/i, "lever"],
  [/^https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/i, "ashby"],
  [/^https?:\/\/apply\.workable\.com\/(?!j\/|api\/)([a-z0-9_-]+)/i, "workable"],
  [/^https?:\/\/([a-z0-9-]+)\.workable\.com/i, "workable"],
];

const RESERVED = new Set(["embed", "v1", "jobs", "www", "apply", "api"]);

/** Recognizes a company board URL on one of the four supported ATSs. */
export function extractBoardRef(url: string): BoardRef | null {
  if (!url) return null;
  for (const [re, ats] of PATTERNS) {
    const m = url.match(re);
    if (m) {
      const slug = decodeURIComponent(m[1]).toLowerCase();
      if (RESERVED.has(slug)) return null;
      return { ats, slug };
    }
  }
  return null;
}

/** Finds every URL in a blob of text/HTML and returns the distinct board refs among them. */
export function harvestRefs(texts: string[]): BoardRef[] {
  const seen = new Map<string, BoardRef>();
  for (const t of texts) {
    for (const m of (t ?? "").matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
      const r = extractBoardRef(m[0].replace(/&amp;/g, "&").replace(/[.,;]+$/, ""));
      if (r) seen.set(`${r.ats}:${r.slug}`, r);
    }
  }
  return [...seen.values()];
}
