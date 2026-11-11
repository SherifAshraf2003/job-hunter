// Runs against DATABASE_URL_TEST.
import "dotenv/config";
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
import type { NormalizedJob } from "../src/sources/types";

async function main() {
  const { db, resetDb, closeDb } = await import("../src/db/client");
  const { jobs, jobSources } = await import("../src/db/schema");
  const { upsertJobs, markClosed, jobKey } = await import("../src/pipeline/upsert");
  await resetDb();
  const base: NormalizedJob = { source: "greenhouse", externalId: "1", url: "https://boards.greenhouse.io/acme/jobs/1", applyUrl: "https://boards.greenhouse.io/acme/jobs/1",
    title: "AI Engineer", companyName: "Acme", location: "Remote", country: null, remotePolicy: "remote", salary: null, descriptionText: "x", postedAt: null, boardSlug: "acme" };
  const ok = (c: boolean, n: string) => console.log(c ? "OK  " : "FAIL", n);

  await upsertJobs([{ ...base, source: "remoteok", externalId: "r1", applyUrl: "https://remoteok.com/x", boardSlug: undefined }]);
  await upsertJobs([base]);
  const js = await db.select().from(jobs); const ss = await db.select().from(jobSources);
  ok(js.length === 1 && ss.length === 2, `dedupe: ${js.length} job, ${ss.length} sources`);
  ok(js[0].applyUrl === base.applyUrl, "ATS apply URL preferred over feed");
  ok(jobKey({ companyName: "Acme, Inc.", title: "AI Engineer (Remote)" }) === "acme|ai engineer", "jobKey normalizes: " + jobKey({ companyName: "Acme, Inc.", title: "AI Engineer (Remote)" }));

  await upsertJobs([{ ...base, externalId: "2", title: "Backend Engineer" }]);
  const closed = await markClosed({ ats: "greenhouse", slug: "acme" }, ["1"]);
  const after = await db.select().from(jobs);
  const be = after.find((j) => j.title === "Backend Engineer")!, ai = after.find((j) => j.title === "AI Engineer")!;
  ok(closed === 1 && be.closedAt !== null && ai.closedAt === null, "markClosed closes only the missing job");
  await upsertJobs([{ ...base, externalId: "2", title: "Backend Engineer" }]);
  const re = (await db.select().from(jobs)).find((j) => j.title === "Backend Engineer")!;
  ok(re.closedAt === null, "re-seen job reopens");
  const r2 = await upsertJobs([base]);
  ok(r2.inserted === 0 && r2.updated === 1 && (await db.select().from(jobSources)).length === 3, "rerun is idempotent");
  await closeDb();
}
main();
