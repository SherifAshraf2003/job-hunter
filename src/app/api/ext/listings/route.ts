import { NextResponse } from "next/server";
import { denyUnlessExtension } from "../auth";
import { saveSetting } from "@/config";
import { upsertJobs } from "@/pipeline/upsert";
import { extractBoardRef } from "@/discovery/boardRefs";
import { addCompanies } from "@/discovery/seed";
import { pauseSite } from "@/apply/report";
import { inferCountry, inferRemote, parseSalary } from "@/sources/text";
import type { NormalizedJob } from "@/sources/types";

export const dynamic = "force-dynamic";

type Listing = { id?: unknown; title?: unknown; company?: unknown; location?: unknown; description?: unknown; easyApply?: unknown; applyUrl?: unknown; salaryText?: unknown };
const str = (v: unknown, max = 20_000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** LinkedIn search results collected by the extension: normalized, deduped and saved like any other source. */
export async function POST(req: Request) {
  const deny = await denyUnlessExtension(req);
  if (deny) return deny;
  const body = (await req.json().catch(() => null)) as { jobs?: Listing[]; done?: boolean; blocked?: string } | null;
  const list = Array.isArray(body?.jobs) ? body!.jobs.slice(0, 200) : [];
  const jobs: NormalizedJob[] = [];
  const refs = [];
  for (const l of list) {
    const id = str(l.id, 30).replace(/\D/g, "");
    const title = str(l.title, 300), company = str(l.company, 200);
    if (!id || !title || !company) continue;
    const location = str(l.location, 200), description = str(l.description);
    const view = `https://www.linkedin.com/jobs/view/${id}/`;
    const external = str(l.applyUrl, 2000);
    const applyUrl = l.easyApply || !/^https?:\/\//.test(external) ? view : external;
    const ref = extractBoardRef(applyUrl);
    if (ref) refs.push({ ...ref, name: company, origin: "harvested" as const });
    jobs.push({
      source: "linkedin", externalId: id, url: view, applyUrl, title, companyName: company, location,
      country: inferCountry(location), remotePolicy: inferRemote(location, description),
      salary: parseSalary(str(l.salaryText, 200)) ?? parseSalary(description.slice(0, 3000)),
      descriptionText: description, postedAt: null,
    });
  }
  const u = await upsertJobs(jobs);
  const harvested = refs.length ? await addCompanies(refs) : 0;
  // A login wall or security check during collection trips the LinkedIn kill switch, same as during applying.
  if (body?.blocked === "blocked" || body?.blocked === "login_wall") await pauseSite("linkedin", body.blocked === "blocked" ? "Unusual activity page" : "Logged out", new Date());
  if (body?.done) await saveSetting("linkedinCollectedAt", new Date().toISOString());
  return NextResponse.json({ ...u, harvested });
}
