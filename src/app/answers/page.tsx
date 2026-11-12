import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { answers } from "@/db/schema";
import { loadSettings, saveSetting } from "@/config";
import { seedBank } from "@/apply/bank";

export const dynamic = "force-dynamic";

async function setupAction(fd: FormData) {
  "use server";
  const v = (k: string) => String(fd.get(k) ?? "").trim().slice(0, 200);
  await seedBank({ phone: v("phone"), city: v("city"), noticePeriod: v("noticePeriod"), relocate: v("relocate") === "No" ? "No" : "Yes", heardFrom: v("heardFrom") });
  redirect("/answers?ok=setup");
}

async function editAction(fd: FormData) {
  "use server";
  const id = Number(fd.get("id"));
  const answer = String(fd.get("answer") ?? "").trim().slice(0, 4000);
  if (!Number.isInteger(id) || !answer) redirect("/answers?err=" + encodeURIComponent("An answer can't be empty. Delete it instead."));
  await db.update(answers).set({ answer, source: "edited", isNew: false, updatedAt: new Date() }).where(eq(answers.id, id));
  redirect("/answers?ok=saved");
}

async function deleteAction(fd: FormData) {
  "use server";
  const id = Number(fd.get("id"));
  if (Number.isInteger(id)) await db.delete(answers).where(eq(answers.id, id));
  redirect("/answers?ok=deleted");
}

async function salaryRuleAction(fd: FormData) {
  "use server";
  await saveSetting("salaryRule", fd.get("salaryRule") === "under_min" ? "under_min" : "under_mid");
  redirect("/answers?ok=rule");
}

const SOURCE = { seed: "From setup", drafted: "Drafted", edited: "Edited by you" } as const;

export default async function Answers({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const cfg = await loadSettings();
  const rows = await db.select().from(answers).orderBy(desc(answers.isNew), asc(answers.question));
  const list = sp.new === "1" ? rows.filter((r) => r.isNew) : rows;
  const seeded = rows.some((r) => r.source === "seed");
  const seed = (q: string) => rows.find((r) => r.source === "seed" && r.question === q)?.answer ?? "";
  const okMsg = { setup: "Saved. These answers are used on every form.", saved: "Answer saved.", deleted: "Answer deleted.", rule: "Salary rule saved." }[sp.ok ?? ""];
  const newCount = rows.filter((r) => r.isNew).length;

  return (
    <div className="app">
      <header className="top">
        <Link className="brand" href="/">Job Finder</Link>
        <div className="today"><Link className="btn" href="/sites">Sites &amp; caps</Link><Link className="btn" href="/">Back to jobs</Link></div>
      </header>
      {sp.err && <p className="err" role="alert">{sp.err}</p>}
      {okMsg && <p className="ok" role="status">{okMsg}</p>}

      <form className="panel" action={setupAction}>
        <h2>{seeded ? "Your details" : "Set up your answers"}</h2>
        <p className="hint">Forms ask for these and your resume doesn&apos;t have them. Each one is saved under the usual ways forms phrase the question.</p>
        <label className="field"><span>Phone (with country code)</span><input name="phone" required defaultValue={seed("Phone")} placeholder="+20 1xx xxx xxxx" /><small>Used for every &quot;Phone&quot; field</small></label>
        <label className="field"><span>City</span><input name="city" required defaultValue={seed("City")} placeholder="Cairo, Egypt" /><small>For location fields</small></label>
        <label className="field"><span>Notice period / start date</span><input name="noticePeriod" defaultValue={seed("Notice period")} placeholder="Available immediately" /><small>For &quot;when can you start&quot;</small></label>
        <label className="field"><span>Willing to relocate</span>
          <select name="relocate" defaultValue={seed("Willing to relocate?") || "Yes"}><option>Yes</option><option>No</option></select><small>Sponsorship is answered separately by rule</small></label>
        <label className="field"><span>How you heard about the job</span><input name="heardFrom" defaultValue={seed("How did you hear about us?") || "Job board"} /><small>Default answer</small></label>
        <button className="btn primary" type="submit">Save details</button>
      </form>

      <section className="panel">
        <h2>Rules</h2>
        <p className="hint">These are worked out per job, not stored as text.</p>
        <form action={salaryRuleAction} className="field">
          <span>Expected salary</span>
          <select name="salaryRule" defaultValue={cfg.salaryRule}>
            <option value="under_mid">10% under the midpoint</option>
            <option value="under_min">10% under the bottom</option>
          </select>
          <small>In the listing&apos;s own currency and period. No salary posted and the form asks: the job waits in Needs you. <button className="btn" type="submit">Save</button></small>
        </form>
        <div className="field"><span>Visa sponsorship</span><b>Yes or No</b><small>No for jobs in Egypt and remote roles you can do from Egypt; Yes for the US and for on-site or hybrid jobs elsewhere.</small></div>
        <div className="field"><span>Work authorization</span><b>Egypt only</b><small>&quot;Authorized to work in the US/UK/...?&quot; is answered No.</small></div>
        <div className="field"><span>Gender, race, veteran, disability</span><b>Decline</b><small>Picks the &quot;decline to answer&quot; option. If there isn&apos;t one, the job waits for you.</small></div>
      </section>

      <section className="panel">
        <h2>Saved answers</h2>
        <p className="hint">
          Answers drafted from your profile for new questions are marked Drafted until you edit them.{" "}
          {sp.new === "1" ? <Link href="/answers">Show all {rows.length}</Link> : newCount ? <Link href="/answers?new=1">Show only the {newCount} new ones</Link> : null}
        </p>
        {list.length === 0 && <p className="hint">{sp.new === "1" ? "No new answers to review." : "No saved answers yet. Fill in your details above."}</p>}
        {list.map((r) => (
          <form key={r.id} className="qa" action={editAction}>
            <input type="hidden" name="id" value={r.id} />
            <div className="q">{r.question} <span className={`pill ${r.isNew ? "hi" : "lo"}`}>{r.isNew ? "New" : SOURCE[r.source]}</span></div>
            <textarea name="answer" defaultValue={r.answer} rows={Math.min(6, Math.max(1, Math.ceil(r.answer.length / 90)))} aria-label={`Answer to ${r.question}`} />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" type="submit">Save</button>
              <button className="btn" type="submit" formAction={deleteAction}>Delete</button>
            </div>
          </form>
        ))}
      </section>
    </div>
  );
}
