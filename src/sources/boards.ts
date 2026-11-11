import { getJson } from "./http";
import { htmlToText, parseSalary, inferRemote, inferCountry } from "./text";
import type { BoardRef, NormalizedJob, Salary } from "./types";

const titleCase = (slug: string) => slug.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const parseDate = (v: unknown) => { const d = v ? new Date(v as string | number) : null; return d && !isNaN(+d) ? d : null; };

// ---------- Greenhouse ----------
type GhJob = { id: number; title: string; absolute_url: string; location?: { name?: string }; content?: string; company_name?: string; first_published?: string; updated_at?: string };

async function greenhouse(slug: string): Promise<NormalizedJob[]> {
  const d = await getJson<{ jobs: GhJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  return d.jobs.map((j) => {
    const location = j.location?.name ?? "";
    const descriptionText = htmlToText(j.content ?? "");
    return {
      source: "greenhouse", externalId: String(j.id), url: j.absolute_url, applyUrl: j.absolute_url,
      title: j.title.trim(), companyName: j.company_name ?? titleCase(slug), location,
      country: inferCountry(location), remotePolicy: inferRemote(location, descriptionText),
      salary: parseSalary(descriptionText), descriptionText,
      postedAt: parseDate(j.first_published ?? j.updated_at), boardSlug: slug,
    };
  });
}

// ---------- Lever ----------
type LeverJob = {
  id: string; text: string; hostedUrl: string; applyUrl: string; country?: string; workplaceType?: string; createdAt?: number;
  categories?: { location?: string; allLocations?: string[] };
  descriptionPlain?: string; additionalPlain?: string; lists?: { text: string; content: string }[];
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
};

const leverPeriod = (i?: string): Salary["period"] => (i?.includes("hour") ? "hour" : i?.includes("month") ? "month" : "year");

async function lever(slug: string): Promise<NormalizedJob[]> {
  const d = await getJson<LeverJob[]>(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return d.map((j) => {
    const location = j.categories?.location ?? j.categories?.allLocations?.join("; ") ?? "";
    const lists = (j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join("\n");
    const descriptionText = [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join("\n").trim();
    const sr = j.salaryRange;
    const salary: Salary | null = sr?.min || sr?.max
      ? { min: sr.min ?? null, max: sr.max ?? null, currency: (sr.currency ?? "USD").toUpperCase(), period: leverPeriod(sr.interval) }
      : parseSalary(descriptionText);
    const wt = j.workplaceType?.toLowerCase();
    return {
      source: "lever", externalId: j.id, url: j.hostedUrl, applyUrl: j.applyUrl ?? j.hostedUrl,
      title: j.text.trim(), companyName: titleCase(slug), location,
      country: j.country ?? inferCountry(location),
      remotePolicy: wt === "remote" ? "remote" : wt === "hybrid" ? "hybrid" : wt === "on-site" || wt === "onsite" ? "onsite" : inferRemote(location, descriptionText),
      salary, descriptionText, postedAt: parseDate(j.createdAt), boardSlug: slug,
    };
  });
}

// ---------- Ashby ----------
type AshbyJob = {
  id: string; title: string; location?: string; secondaryLocations?: { location?: string }[]; isRemote?: boolean; workplaceType?: string;
  jobUrl: string; applyUrl?: string; descriptionPlain?: string; descriptionHtml?: string; publishedAt?: string; isListed?: boolean;
  address?: { postalAddress?: { addressCountry?: string } };
  compensation?: { scrapeableCompensationSalarySummary?: string | null; compensationTierSummary?: string | null };
};

async function ashby(slug: string): Promise<NormalizedJob[]> {
  const d = await getJson<{ jobs: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
  return d.jobs.filter((j) => j.isListed !== false).map((j) => {
    const location = [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(Boolean).join("; ");
    const descriptionText = j.descriptionPlain?.trim() || htmlToText(j.descriptionHtml ?? "");
    const comp = j.compensation?.scrapeableCompensationSalarySummary ?? j.compensation?.compensationTierSummary ?? "";
    const wt = j.workplaceType?.toLowerCase();
    return {
      source: "ashby", externalId: j.id, url: j.jobUrl, applyUrl: j.applyUrl ?? j.jobUrl,
      title: j.title.trim(), companyName: titleCase(slug), location,
      country: inferCountry(location) ?? null,
      remotePolicy: wt === "remote" || (j.isRemote && wt !== "hybrid") ? "remote" : wt === "hybrid" ? "hybrid" : wt === "onsite" ? "onsite" : inferRemote(location, descriptionText),
      salary: parseSalary(comp) ?? parseSalary(descriptionText), descriptionText,
      postedAt: parseDate(j.publishedAt), boardSlug: slug,
    };
  });
}

// ---------- Workable ----------
type WorkableJob = {
  title: string; shortcode: string; url: string; application_url?: string; telecommuting?: boolean; published_on?: string;
  country?: string; city?: string; description?: string; locations?: { country?: string; countryCode?: string; city?: string }[];
};

async function workable(slug: string): Promise<NormalizedJob[]> {
  const d = await getJson<{ name?: string; jobs: WorkableJob[] }>(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`);
  return (d.jobs ?? []).map((j) => {
    const loc0 = j.locations?.[0];
    const location = [j.city ?? loc0?.city, j.country ?? loc0?.country].filter(Boolean).join(", ");
    const descriptionText = htmlToText(j.description ?? "");
    return {
      source: "workable", externalId: j.shortcode, url: j.url, applyUrl: j.application_url ?? j.url,
      title: j.title.trim(), companyName: d.name ?? titleCase(slug), location,
      country: loc0?.countryCode ?? inferCountry(location),
      remotePolicy: j.telecommuting ? "remote" : inferRemote(location, descriptionText),
      salary: parseSalary(descriptionText), descriptionText, postedAt: parseDate(j.published_on), boardSlug: slug,
    };
  });
}

const fetchers = { greenhouse, lever, ashby, workable } as const;

/** Fetches every open job on one company board. Throws BoardNotFoundError on 404. */
export function fetchBoard(ref: BoardRef): Promise<NormalizedJob[]> {
  return fetchers[ref.ats](ref.slug);
}
