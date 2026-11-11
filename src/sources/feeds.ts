import { XMLParser } from "fast-xml-parser";
import { inArray } from "drizzle-orm";
import { getJson, getText } from "./http";
import { htmlToText, parseSalary, inferCountry, inferRemote } from "./text";
import { harvestRefs } from "../discovery/boardRefs";
import { chatJSON, BudgetExceededError, InvalidLLMOutputError } from "../llm/openrouter";
import { db } from "../db/client";
import { jobSources } from "../db/schema";
import type { NormalizedJob, SourceResult } from "./types";

/** RemoteOK sometimes serves UTF-8 text that was decoded as Latin-1 ("â\u0080\u0094"). */
function fixMojibake(s: string): string {
  if (!/[Â-ô][\u0080-¿]/.test(s ?? "")) return s ?? "";
  try { return Buffer.from(s, "latin1").toString("utf8"); } catch { return s; }
}

// ---------- RemoteOK ----------
type RemoteOkJob = { id: string; date?: string; company: string; position: string; description?: string; location?: string; apply_url?: string; url: string; salary_min?: number | string; salary_max?: number | string };

export async function fetchRemoteOk(): Promise<SourceResult> {
  const d = await getJson<RemoteOkJob[]>("https://remoteok.com/api");
  const items = d.filter((x) => x && (x as RemoteOkJob).position);
  const jobs: NormalizedJob[] = items.map((j) => {
    const descriptionText = htmlToText(fixMojibake(j.description ?? ""));
    const smin = Number(j.salary_min) || null, smax = Number(j.salary_max) || null;
    return {
      source: "remoteok", externalId: String(j.id), url: j.url, applyUrl: j.apply_url || j.url,
      title: fixMojibake(j.position).trim(), companyName: fixMojibake(j.company).trim(),
      location: j.location || "Remote", country: inferCountry(j.location ?? ""), remotePolicy: "remote",
      salary: smin || smax ? { min: smin, max: smax, currency: "USD", period: "year" } : parseSalary(descriptionText),
      descriptionText, postedAt: j.date ? new Date(j.date) : null,
    };
  });
  return { jobs, harvested: harvestRefs(items.map((j) => `${j.apply_url ?? ""} ${j.description ?? ""}`)) };
}

// ---------- We Work Remotely ----------
const WWR_FEEDS = [
  "https://weworkremotely.com/categories/remote-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
];
type RssItem = { title: string; link: string; guid?: string | { "#text": string }; region?: string; description?: string; pubDate?: string };

export async function fetchWwr(): Promise<SourceResult> {
  const parser = new XMLParser({ ignoreAttributes: true });
  const jobs: NormalizedJob[] = [];
  const raw: string[] = [];
  for (const url of WWR_FEEDS) {
    const xml = parser.parse(await getText(url));
    const items: RssItem[] = [xml?.rss?.channel?.item ?? []].flat();
    for (const it of items) {
      const [company, ...rest] = String(it.title).split(":");
      const title = rest.join(":").trim() || String(it.title);
      const descriptionText = htmlToText(it.description ?? "");
      const region = it.region ?? "Remote";
      raw.push(it.description ?? "");
      jobs.push({
        source: "wwr", externalId: typeof it.guid === "object" ? it.guid["#text"] : String(it.guid ?? it.link), url: it.link, applyUrl: it.link,
        title, companyName: company.trim(), location: `Remote (${region})`, country: null, remotePolicy: "remote",
        salary: parseSalary(descriptionText), descriptionText, postedAt: it.pubDate ? new Date(it.pubDate) : null,
      });
    }
  }
  return { jobs, harvested: harvestRefs(raw) };
}

// ---------- Hacker News "Who is hiring?" ----------
type HnItem = { id: number; text?: string; author?: string; created_at?: string; children?: HnItem[] };
type HnExtract = { jobs: { company: string; title: string; location: string; remote: boolean; visa: boolean | null; url: string | null; salaryText: string | null }[] };

const HN_SYSTEM = `You extract job postings from a Hacker News "Who is hiring?" comment.
Return JSON: {"jobs":[{"company":string,"title":string,"location":string,"remote":boolean,"visa":boolean|null,"url":string|null,"salaryText":string|null}]}.
One entry per distinct role. Use the posting's own words. "url" is the best apply or careers link in the comment, or null.
"visa" is true if they say they sponsor visas, false if they say they don't, null if not mentioned.
If the comment is not a job posting, return {"jobs":[]}.`;

export async function fetchHn(opts: { maxComments?: number } = {}): Promise<SourceResult> {
  const search = await getJson<{ hits: { objectID: string; title: string }[] }>(
    "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10");
  const story = search.hits.find((h) => /^Ask HN: Who is hiring/i.test(h.title));
  if (!story) return { jobs: [], harvested: [] };
  const thread = await getJson<HnItem>(`https://hn.algolia.com/api/v1/items/${story.objectID}`);
  const comments = (thread.children ?? []).filter((c) => c.text && c.text.length > 80);

  // Skip comments already processed in an earlier run.
  const ids = comments.map((c) => `hn:${c.id}`);
  const done = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db.select({ e: jobSources.externalId }).from(jobSources)
      .where(inArray(jobSources.externalId, ids.slice(i, i + 500).flatMap((id) => [id, `${id}:0`])));
    rows.forEach((r) => done.add(r.e.split(":").slice(0, 2).join(":")));
  }
  const todo = comments.filter((c) => !done.has(`hn:${c.id}`)).slice(0, opts.maxComments ?? Infinity);

  const jobs: NormalizedJob[] = [];
  const errors: string[] = [];
  for (const c of todo) {
    const text = htmlToText(c.text!);
    let out: HnExtract;
    try {
      out = await chatJSON<HnExtract>({
        model: process.env.OPENROUTER_CHEAP_MODEL!, system: HN_SYSTEM, user: text.slice(0, 6000),
        category: "scoring", estimateUsd: 0.002,
      });
    } catch (e) {
      if (e instanceof BudgetExceededError) break;
      if (e instanceof InvalidLLMOutputError) { errors.push(`hn:${c.id} ${e.message}`); continue; }
      throw e;
    }
    const permalink = `https://news.ycombinator.com/item?id=${c.id}`;
    (out.jobs ?? []).forEach((j, idx) => {
      if (!j.company || !j.title) return;
      const location = j.location ?? "";
      jobs.push({
        source: "hn", externalId: `hn:${c.id}:${idx}`, url: permalink, applyUrl: j.url || permalink,
        title: j.title.trim(), companyName: j.company.trim(), location,
        country: inferCountry(location),
        remotePolicy: j.remote ? "remote" : inferRemote(location, text),
        salary: parseSalary(j.salaryText ?? "") ?? parseSalary(text),
        descriptionText: text + (j.visa === true ? "\nVisa sponsorship: yes" : j.visa === false ? "\nVisa sponsorship: no" : ""),
        postedAt: c.created_at ? new Date(c.created_at) : null,
      });
    });
  }
  if (errors.length) console.warn(`[hn] skipped ${errors.length} comments with invalid LLM output`);
  return { jobs, harvested: harvestRefs(todo.map((c) => c.text ?? "")) };
}
