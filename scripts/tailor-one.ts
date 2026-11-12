// Usage: npx tsx scripts/tailor-one.ts <jobId> [--tier top|middle|bottom] [--model <id>] [--inject-fake] [--pdf] [--out <dir>]
import { eq } from "drizzle-orm";
import path from "node:path";
import { readFileSync } from "node:fs";

async function main() {
  const args = process.argv.slice(2);
  const flag = (n: string) => args.includes(`--${n}`);
  const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const id = Number(args[0]);
  const { db, closeDb } = await import("../src/db/client");
  const { jobs, spend } = await import("../src/db/schema");
  const { loadProfile } = await import("../src/profile/load");
  const { pickTreatment } = await import("../src/tailor/tiers");
  const { generateResume, generateExtras, wantsCoverLetter } = await import("../src/tailor/generate");
  const { truthCheck, sourceText } = await import("../src/tailor/truth");
  const { gte } = await import("drizzle-orm");

  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!job) { console.log("no such job"); return closeDb(); }
  const p = await loadProfile();
  const t = pickTreatment((opt("tier") as "top" | "middle" | "bottom") ?? "top", 0);
  if (opt("model")) t.resumeModel = opt("model")!;
  const t0 = new Date();
  console.log(`== #${id} ${job.title} @ ${job.companyName} | tier ${t.tier} | ${t.resumeModel} | ${t.rewrite}`);

  let r = await generateResume(job, p, t);
  if (flag("inject-fake")) r.roles[0].bullets.push({ source: "r0b0", text: "Led a team of 40 engineers at Google" });
  const { resume, issues } = await truthCheck(r, p, t.extrasModel, undefined, job.descriptionText);
  r = resume;
  console.log(`headline: ${r.headline}`);
  for (const role of r.roles) {
    console.log(`-- ${p.roles[role.roleIdx].title} @ ${p.roles[role.roleIdx].org}`);
    for (const b of role.bullets) {
      const src = sourceText(p, b.source);
      console.log(`  [${b.source}] ${b.text}${src === b.text ? "  (unchanged)" : `\n        was: ${src}`}`);
    }
  }
  console.log(`projects: ${r.projects.map((x) => x.source).join(", ")} | skills: ${r.skills.map((c) => `${c.category}: ${c.items.join(", ")}`).join(" | ")}`);
  console.log(`issues (${issues.length}):`, issues.map((i) => `${i.where} ${i.action}: ${i.problem}`).join("\n  ") || "none");

  const ex = await generateExtras(job, p, t, { coverLetter: wantsCoverLetter(job), insights: true });
  console.log("gaps:", (ex.gapReport ?? []).map((g) => `[${g.importance}] ${g.requirement} -> ${g.suggestion}`).join("\n  "));
  console.log("prep:", (ex.prep?.questions ?? []).map((q) => q.question).join("\n  "), "\nnotes:", (ex.prep?.companyNotes ?? []).join(" / "));
  console.log("cover letter:", ex.coverLetter ? `${ex.coverLetter.split(/\s+/).length} words` : "none");

  if (flag("pdf")) {
    const { fitOnePage } = await import("../src/tailor/latex");
    const out = opt("out") ?? path.join(".superpowers/tmp/tailor", String(id));
    try {
      const f = await fitOnePage(r, p, readFileSync("resume.tex", "utf8"), out);
      console.log("pdf:", f.pdfPath);
    } catch (e) { console.log("pdf error:", (e as Error).message); }
  }
  const rows = await db.select().from(spend).where(gte(spend.at, t0));
  console.log(`cost: $${rows.reduce((a, x) => a + Number(x.usd), 0).toFixed(4)} over ${rows.length} calls`);
  await closeDb();
}
main();
