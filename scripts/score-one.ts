import { eq } from "drizzle-orm";
import { prefilter } from "../src/pipeline/prefilter";
import { composite } from "../src/scoring/composite";
import { config } from "../src/config";

async function main() {
  const ok = (c: boolean, n: string) => console.log(c ? "OK  " : "FAIL", n);
  const pf = (t: string, d = "") => prefilter({ title: t, descriptionText: d });
  ok(pf("Senior Software Engineer").pass, "senior SWE passes");
  ok(JSON.stringify(pf("Software Engineering Intern")) === JSON.stringify({ pass: false, reason: "excluded title: intern" }), "intern excluded");
  ok(!pf("Account Executive").pass, "account exec excluded");
  ok(JSON.stringify(pf("AI Engineer", "10+ years of experience")) === JSON.stringify({ pass: false, reason: "requires 8+ years" }), "10+ years excluded");
  ok(pf("Founding Engineer").pass, "founding passes");
  ok(pf("Member of Technical Staff").pass, "member of technical staff passes");
  ok(pf("Software Engineer", "Founded 12 years ago, we have grown fast.").pass, "'founded 12 years ago' is not an experience requirement");
  ok(!pf("Staff Software Engineer").pass, "staff engineer still excluded");
  const d = (v: number) => ({ scope: v, company: v, pay: v, level: v, fit: v });
  ok(composite({ ...d(100), canTake: "sponsors" }, config.weights).score === 100, "composite 100");
  ok(composite({ ...d(50), canTake: "unclear" }, config.weights).score === 45, "unclear -5");
  ok(composite({ ...d(90), canTake: "not_possible" }, config.weights).sortGroup === 1, "not_possible last");

  const ids = process.argv.slice(2).map(Number).filter(Boolean);
  if (!ids.length) return;
  const { db, closeDb } = await import("../src/db/client");
  const { jobs, spend } = await import("../src/db/schema");
  const { makeJevScorer } = await import("../src/scoring/jev");
  const { loadProfile } = await import("../src/profile/load");
  const scorer = makeJevScorer();
  const p = await loadProfile();
  for (const id of ids) {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
    try {
      const s = await scorer.score(job, p);
      const c = composite(s, config.weights);
      console.log(`#${id} ${job.title} @ ${job.companyName} (${job.location}) -> scope ${s.scope} company ${s.company} pay ${s.pay} level ${s.level} fit ${s.fit} | ${s.canTake} (${s.canTakeConfidence.toFixed(2)}) | composite ${c.score}`);
    } catch (e) {
      console.log(`#${id} error: ${(e as Error).message}`);
    }
  }
  const rows = await db.select().from(spend);
  console.log("spend rows:", rows.map((r) => `${r.provider} $${Number(r.usd).toFixed(6)} in=${r.inputTokens}`).join(", "));
  await closeDb();
}
main();
