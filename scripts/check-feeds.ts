import { fetchRemoteOk, fetchWwr, fetchHn } from "../src/sources/feeds";
import { extractBoardRef } from "../src/discovery/boardRefs";
import { closeDb } from "../src/db/client";

async function main() {
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const refs: [string, unknown, unknown][] = [
    ["lever ref", extractBoardRef("https://jobs.lever.co/palantir/abc"), { ats: "lever", slug: "palantir" }],
    ["gh ref", extractBoardRef("https://job-boards.greenhouse.io/anthropic/jobs/1"), { ats: "greenhouse", slug: "anthropic" }],
    ["no ref", extractBoardRef("https://example.com"), null],
  ];
  for (const [n, g, w] of refs) console.log(eq(g, w) ? "OK  " : "FAIL", n, JSON.stringify(g));

  const r = await fetchRemoteOk();
  console.log(r.jobs.every((j) => j.title && j.companyName) ? "OK  " : "FAIL", `remoteok ${r.jobs.length} jobs, harvested ${r.harvested.length}`, r.jobs[0]?.title);
  const w = await fetchWwr();
  console.log(w.jobs.every((j) => j.title && j.companyName) ? "OK  " : "FAIL", `wwr ${w.jobs.length} jobs, harvested ${w.harvested.length}`, `${w.jobs[0]?.companyName} / ${w.jobs[0]?.title}`);
  if (process.env.OPENROUTER_API_KEY) {
    const h = await fetchHn({ maxComments: 5 });
    console.log(h.jobs.length ? "OK  " : "FAIL", `hn ${h.jobs.length} jobs from 5 comments, harvested ${h.harvested.length}`);
    for (const j of h.jobs) console.log("   ", j.externalId, "|", j.companyName, "|", j.title, "|", j.location, "|", j.applyUrl);
  } else console.log("SKIP hn (no OPENROUTER_API_KEY)");
  await closeDb();
}
main();
