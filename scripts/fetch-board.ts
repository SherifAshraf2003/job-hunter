import { fetchBoard } from "../src/sources/boards";
import type { Ats } from "../src/sources/types";

async function main() {
  const [ats, slug] = process.argv.slice(2) as [Ats, string];
  try {
    const jobs = await fetchBoard({ ats, slug });
    const bad = jobs.filter((j) => !j.title || !j.applyUrl.startsWith("https://") || /<[a-z]/i.test(j.descriptionText) || j.source !== ats);
    console.log(`${ats}/${slug}: ${jobs.length} jobs, ${bad.length} malformed, ${jobs.filter((j) => j.salary).length} with salary`);
    const s = jobs.find((j) => j.salary) ?? jobs[0];
    if (s) console.log(JSON.stringify({ ...s, descriptionText: s.descriptionText.slice(0, 160) }, null, 2));
    process.exit(bad.length || !jobs.length ? 1 : 0);
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
    process.exit(2);
  }
}
main();
