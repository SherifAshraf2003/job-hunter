import Link from "next/link";
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs } from "@/db/schema";
import { loadSettings } from "@/config";
import { listJobs, getJob, stageCounts, latestRun, sourceCount, getTailoring, gapCounts, gapKey, getApplication, todayCounts, type JobFilters } from "@/queries/jobs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { tailorings, applications, sites, answers } from "@/db/schema";
import { approve, refill } from "@/apply/queue";
import type { Fill } from "@/apply/types";
import { CopyButton } from "./components/CopyButton";
import type { DiffRow } from "@/tailor/diff";
import type { GapItem, Prep, TruthIssue } from "@/tailor/types";
import { spendSummary } from "@/budget/budget";
import { DIMS, FEAS_LABEL, JobRow, salaryText } from "./components/ui";
import { RunNow } from "./components/RunNow";
import { generateExtras } from "@/tailor/generate";
import { pickTreatment } from "@/tailor/tiers";
import { loadProfile } from "@/profile/load";
import { BudgetExceededError } from "@/llm/openrouter";

export const dynamic = "force-dynamic";

type SP = Record<string, string | undefined>;

const CHIPS: { key: keyof JobFilters; label: string; value: string }[] = [
  { key: "canTake", label: "Can take it", value: "1" },
  { key: "salaryPosted", label: "Salary posted", value: "1" },
  { key: "minScore", label: "Score 60+", value: "60" },
  { key: "ai", label: "AI roles", value: "1" },
  { key: "founding", label: "Founding", value: "1" },
  { key: "remote", label: "Remote", value: "1" },
];
const STAGES = [
  { key: "found", label: "Found, not scored yet", count: "found" },
  { key: "scored", label: "Scored", count: "scored" },
  { key: "tailored", label: "Resume tailored", count: "tailored" },
  { key: "ready", label: "Ready to submit", count: "ready" },
  { key: "needs_you", label: "Needs you", count: "needsYou" },
  { key: "applied", label: "Applied", count: "applied" },
  { key: "interviewing", label: "Interviewing", count: "interviewing" },
  { key: "manual", label: "Apply yourself", count: "manual" },
  { key: "filtered_out", label: "Filtered out", count: "filteredOut" },
  { key: "score_failed", label: "Scoring failed", count: "failed" },
] as const;

function href(sp: SP, patch: SP): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `/?${s}` : "/";
}

function ago(d: Date | null | undefined): string {
  if (!d) return "never";
  const m = Math.round((Date.now() - +d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

async function skipJob(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  await db.update(jobs).set({ status: "filtered_out", statusReason: "skipped by you" }).where(eq(jobs.id, id));
  // Skipping also takes it out of the apply queue, unless it was already sent.
  await db.update(applications).set({ status: "skipped", reason: "Skipped by you", approved: false })
    .where(and(eq(applications.jobId, id), inArray(applications.status, ["queued", "ready_to_submit", "needs_you", "failed", "manual"])));
  revalidatePath("/");
}

async function retailor(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id <= 0) return;
  await db.delete(tailorings).where(eq(tailorings.jobId, id));
  await rm(path.join(process.cwd(), "data", "out", String(id)), { recursive: true, force: true });
  revalidatePath("/");
}

async function prepareInsights(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id <= 0) return;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!job) return;
  try {
    const out = await generateExtras(job, await loadProfile(), pickTreatment("middle", 0), { coverLetter: false, insights: true });
    await db.update(tailorings).set({ gapReport: out.gapReport, prep: out.prep }).where(eq(tailorings.jobId, id));
  } catch (e) {
    if (!(e instanceof BudgetExceededError)) throw e;
  }
  revalidatePath("/");
}

async function approveAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (Number.isInteger(id) && id > 0) await approve(id);
  revalidatePath("/");
}

async function refillAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  if (Number.isInteger(id) && id > 0) await refill(id);
  revalidatePath("/");
}

const MANUAL_STATUSES = ["applied", "interviewing", "rejected", "offer"] as const;

/** Statuses Sherif sets by hand: "I submitted it", then Interviewing / Rejected / Offer (spec 6.6). */
async function setStatusAction(formData: FormData) {
  "use server";
  const id = Number(formData.get("id"));
  const status = String(formData.get("status")) as (typeof MANUAL_STATUSES)[number];
  if (!Number.isInteger(id) || id <= 0 || !MANUAL_STATUSES.includes(status)) return;
  const [a] = await db.select().from(applications).where(eq(applications.jobId, id));
  if (!a) return;
  await db.update(applications).set({ status, reason: null, leaseAt: null, ...(status === "applied" && !a.appliedAt ? { appliedAt: new Date() } : {}) })
    .where(eq(applications.jobId, id));
  revalidatePath("/");
}

const SOURCE_LABEL: Record<Fill["source"], string> = { profile: "Profile", rule: "Rule", bank: "Bank", drafted: "Drafted", job: "Job" };

const TABS = [
  { key: "resume", label: "Resume" }, { key: "cover", label: "Cover letter" }, { key: "gaps", label: "Gaps" },
  { key: "prep", label: "Interview prep" }, { key: "answers", label: "Form answers" }, { key: "description", label: "Description" },
] as const;

export default async function Home({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const cfg = await loadSettings();
  const filters: JobFilters = {
    stage: (sp.stage as JobFilters["stage"]) ?? "scored",
    canTake: sp.canTake === "1", salaryPosted: sp.salaryPosted === "1", ai: sp.ai === "1",
    founding: sp.founding === "1", remote: sp.remote === "1",
    minScore: sp.minScore ? Number(sp.minScore) : undefined,
  };
  const [list, counts, run, spend, nSources, today, siteRows, newAnswers] = await Promise.all([
    listJobs(filters, cfg.weights), stageCounts(), latestRun(), spendSummary(), sourceCount(), todayCounts(),
    db.select().from(sites), db.select({ id: answers.id }).from(answers).where(eq(answers.isNew, true)),
  ]);
  const pausedSites = siteRows.filter((x) => x.paused);
  const selectedId = sp.job ? Number(sp.job) : list[0]?.id;
  const job = selectedId ? await getJob(selectedId, cfg.weights) : null;
  const tailoring = job ? await getTailoring(job.id) : null;
  const app = job ? await getApplication(job.id) : null;
  const fills = (app?.fills as Fill[] | null) ?? null;
  const gaps = tailoring ? await gapCounts() : new Map<string, number>();
  const visibleTabs = TABS.filter((t) => t.key === "description" || (tailoring && (t.key !== "cover" || tailoring.coverLetter) && (!["gaps", "prep"].includes(t.key) || tailoring.pdfPath) && (t.key === "resume" || !tailoring.error || tailoring.pdfPath)) && (t.key !== "answers" || !!fills?.length));
  const wanted = (sp.tab as (typeof TABS)[number]["key"]) ?? (tailoring ? "resume" : "description");
  const tab = visibleTabs.some((t) => t.key === wanted) ? wanted : visibleTabs[0].key;
  const showChanges = sp.changes === "1";
  const running = run?.status === "running";
  const errors = ((run?.stats as { errors?: string[] } | null)?.errors ?? []).length;

  return (
    <div className="app">
      <header className="top">
        <Link className="brand" href="/">Job Finder</Link>
        <div className="run">
          <span className={`dot ${running ? "" : "idle"}`} />
          {running ? "Searching now" : `Last search ${ago(run?.finishedAt)} across ${nSources} sources`}
          {errors > 0 && !running ? `, ${errors} source errors` : ""}
        </div>
        <div className="today">
          <span>Spend today <b>${spend.todayUsd.toFixed(2)}</b></span>
          <span>This month <b>${spend.monthUsd.toFixed(2)}</b> of ${spend.capUsd}</span>
          <span>Applied today <b>{today.applied}</b> of {cfg.caps.globalDaily}</span>
          <span>LinkedIn <b>{today.linkedin}</b> of {siteRows.find((x) => x.site === "linkedin")?.dailyCap ?? cfg.caps.linkedinDaily}</span>
          {(cfg.globalPause || pausedSites.length > 0) && (
            <Link className="pill hi" href="/sites">{cfg.globalPause ? "Applying paused" : `Paused: ${pausedSites.map((x) => x.site).join(", ")}`}</Link>
          )}
          <Link className="btn" href="/answers">Answers{newAnswers.length ? ` (${newAnswers.length} new)` : ""}</Link>
          <Link className="btn" href="/sites">Sites &amp; caps</Link>
          <RunNow />
          <Link className="btn" href="/settings">Settings</Link>
        </div>
      </header>

      <nav className="stages" aria-label="Pipeline stage">
        {STAGES.map((s) => (
          <Link key={s.key} className={`stage ${(s.key === "score_failed" && counts.failed) || (s.key === "needs_you" && counts.needsYou) ? "warn" : ""}`}
            href={href(sp, { stage: s.key === "scored" ? undefined : s.key, job: undefined })}
            aria-current={(filters.stage ?? "scored") === s.key}>
            <span className="n">{counts[s.count]}</span><span className="l">{s.label}</span>
          </Link>
        ))}
      </nav>

      <div className="main">
        <section className="list" aria-label="Ranked jobs">
          <div className="filters">
            {CHIPS.map((c) => {
              const on = sp[c.key] === c.value;
              return <Link key={c.key} className="chip" aria-pressed={on} scroll={false} href={href(sp, { [c.key]: on ? undefined : c.value, job: undefined })}>{c.label}</Link>;
            })}
            <span className="sort">{list.length} jobs, sorted by score</span>
          </div>
          <div className="legend">
            {DIMS.map((d) => <span key={d.key}><i style={{ background: d.color }} />{d.label}</span>)}
          </div>
          {list.length === 0 ? (
            <div className="empty">No jobs match these filters. Turn a filter off, or press Run now to search again.</div>
          ) : list.map((j, i) => (
            <JobRow key={j.id} j={j} i={i} w={cfg.weights} href={href(sp, { job: String(j.id) })} current={j.id === job?.id} />
          ))}
        </section>

        {job && (
          <aside className="dossier" aria-live="polite">
            <div className="dh">
              <h1>{job.title}</h1>
              <div className="sub">{job.companyName}{job.location ? `, ${job.location}` : ""}</div>
              <div className="facts">
                <div><span>Score</span><b>{job.composite ?? "Not scored"}</b></div>
                <div><span>Salary</span>{salaryText(job) ?? "Not posted"}{job.salaryUsdYearMid ? <div className="feas">≈ ${Math.round(job.salaryUsdYearMid / 1000)}k/yr</div> : null}</div>
                <div><span>Can you take it</span>{job.scores ? FEAS_LABEL[job.scores.canTake][0] : "Not scored"}</div>
                <div><span>Found on</span>{job.sources.map((s, i) => <span key={i} style={{ display: "inline", color: "inherit", fontSize: 13 }}>{i ? ", " : ""}<a href={s.url} target="_blank" rel="noreferrer">{s.source}</a></span>)}</div>
              </div>
            </div>
            {job.scores ? (
              <div className="why">
                <h2>Why it ranks here</h2>
                {DIMS.map((d) => (
                  <div className="dim" key={d.key}>
                    <span>{d.label}</span>
                    <div className="track"><span style={{ width: `${job.scores![d.key]}%`, background: d.color }} /></div>
                    <b>{Math.round(job.scores![d.key])}</b>
                  </div>
                ))}
              </div>
            ) : job.statusReason ? <div className="note">{job.statusReason}</div> : null}
            {app?.status === "needs_you" && <div className="note"><b>Needs you:</b> {app.reason ?? "Finish this application in Chrome."}</div>}
            {app?.status === "ready_to_submit" && <div className="note">Ready to submit{app.reason ? ` (${app.reason})` : ""}. {cfg.trustRemaining > 0 ? `${cfg.trustRemaining} approvals left in the trust period.` : ""}</div>}
            {app?.status === "failed" && <div className="note">Applying failed: {app.reason}</div>}
            {app && (
              <div className="actions">
                {app.status === "ready_to_submit" && !app.approved && (
                  <form action={approveAction}><input type="hidden" name="id" value={job.id} /><button className="btn primary" type="submit">Approve and submit</button></form>
                )}
                {app.status === "ready_to_submit" && app.approved && <span className="feas">Approved: the extension submits it next.</span>}
                {["needs_you", "failed", "ready_to_submit"].includes(app.status) && (
                  <form action={refillAction}><input type="hidden" name="id" value={job.id} /><button className="btn" type="submit">Fill again in Chrome</button></form>
                )}
                {["needs_you", "ready_to_submit", "manual", "failed"].includes(app.status) && (
                  <form action={setStatusAction}><input type="hidden" name="id" value={job.id} /><input type="hidden" name="status" value="applied" /><button className="btn" type="submit">I submitted it</button></form>
                )}
                {["applied", "interviewing", "rejected", "offer"].includes(app.status) && (["interviewing", "rejected", "offer"] as const).map((st) => (
                  <form key={st} action={setStatusAction}><input type="hidden" name="id" value={job.id} /><input type="hidden" name="status" value={st} />
                    <button className="btn" type="submit" aria-pressed={app.status === st}>{st[0].toUpperCase() + st.slice(1)}</button></form>
                ))}
                {app.status === "manual" && <a className="btn primary" href={app.targetUrl} target="_blank" rel="noreferrer">Open listing to apply</a>}
                <span className="feas" style={{ alignSelf: "center" }}>{app.site}, {app.status.replace(/_/g, " ")}{app.appliedAt ? `, applied ${app.appliedAt.toLocaleDateString()}` : ""}</span>
              </div>
            )}
            <div className="actions">
              <a className="btn primary" href={job.applyUrl} target="_blank" rel="noreferrer">View listing</a>
              {job.status !== "filtered_out" && (
                <form action={skipJob}><input type="hidden" name="id" value={job.id} /><button className="btn" type="submit">Skip job</button></form>
              )}
            </div>
            {tailoring && (
              <div className="actions" style={{ paddingTop: 8 }}>
                {tailoring.pdfPath && <a className="btn" href={`/api/pdf/${job.id}?download=1`}>Download PDF</a>}
                <form action={retailor}><input type="hidden" name="id" value={job.id} /><button className="btn" type="submit">Re-tailor</button></form>
                <span className="feas" style={{ alignSelf: "center" }}>{tailoring.tier} tier, {tailoring.model.replace(/^.*\//, "")}, ${Number(tailoring.usd).toFixed(3)}</span>
              </div>
            )}
            <div className="tabs" role="tablist">
              {visibleTabs.map((t) => (
                <Link key={t.key} role="tab" className="tab" aria-selected={tab === t.key} scroll={false} href={href(sp, { tab: t.key })}>{t.label}</Link>
              ))}
            </div>
            <div className="pane">
              {tab === "resume" && tailoring && (
                tailoring.error && !tailoring.pdfPath ? (
                  <div className="note">Tailoring failed: {tailoring.error}. Press Re-tailor to try again on the next search.</div>
                ) : (
                  <>
                    <div className="pane-tools">
                      <Link scroll={false} href={href(sp, { changes: showChanges ? undefined : "1" })}>{showChanges ? "Show the PDF" : "Show changes from your base resume"}</Link>
                      <span>One page, your LaTeX layout</span>
                    </div>
                    {showChanges ? (
                      <div className="textpane">
                        {((tailoring.diff as DiffRow[] | null) ?? []).filter((d) => d.kind !== "same").map((d, i) => (
                          <div key={i} className={`diffrow ${d.kind}`}>
                            <div className="q">{d.section}: {d.kind === "changed" ? "reworded" : d.kind === "moved" ? "moved up" : "left out"}</div>
                            {d.tailored && <div>{d.tailored}</div>}
                            {d.kind === "changed" && <div className="was">Was: {d.base}</div>}
                            {d.kind === "dropped" && <div className="was">{d.base}</div>}
                          </div>
                        ))}
                        {(tailoring.issues as TruthIssue[] | null)?.length ? (
                          <div className="issues">
                            <h3>Reverted to your original wording</h3>
                            {(tailoring.issues as TruthIssue[]).map((x, i) => <div key={i} className="q">{x.where}: {x.problem}</div>)}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <iframe className="pdf" title="Tailored resume" src={`/api/pdf/${job.id}#view=FitH&toolbar=0`} />
                    )}
                  </>
                )
              )}
              {tab === "cover" && tailoring && (
                tailoring.coverLetter ? (
                  <div className="textpane"><pre className="plain">{tailoring.coverLetter}</pre><CopyButton text={tailoring.coverLetter} label="Copy cover letter" /></div>
                ) : <div className="textpane">This listing doesn&apos;t ask for a cover letter.</div>
              )}
              {(tab === "gaps" || tab === "prep") && tailoring && !tailoring.gapReport && (
                <div className="textpane">
                  <p>Gaps and interview prep aren&apos;t generated automatically, to save money. This makes one small model call (under $0.01).</p>
                  <form action={prepareInsights}><input type="hidden" name="id" value={job.id} /><button className="btn" type="submit">Generate gaps and interview prep</button></form>
                </div>
              )}
              {tab === "gaps" && !!tailoring?.gapReport && (
                <div className="textpane">
                  {(tailoring.gapReport as GapItem[]).length === 0 && <p>No gaps found: your resume covers what this listing asks for.</p>}
                  {((tailoring.gapReport as GapItem[]) ?? []).map((g, i) => (
                    <div className="gap" key={i}>
                      <span className="need">{g.requirement}</span>
                      <span className={`pill ${g.importance === "core" ? "hi" : "lo"}`}>{g.importance === "core" ? "Core" : "Nice to have"}{(gaps.get(gapKey(g.requirement)) ?? 0) > 1 ? `, asked in ${gaps.get(gapKey(g.requirement))} jobs` : ""}</span>
                      <span className="fix">{g.suggestion}</span>
                    </div>
                  ))}
                </div>
              )}
              {tab === "prep" && !!tailoring?.gapReport && (
                <div className="textpane">
                  {((tailoring.prep as Prep | null)?.companyNotes ?? []).length > 0 && (
                    <div className="qa"><div className="q">About them</div>{((tailoring.prep as Prep | null)?.companyNotes ?? []).map((n, i) => <p key={i} style={{ margin: "4px 0" }}>{n}</p>)}</div>
                  )}
                  {((tailoring.prep as Prep | null)?.questions ?? []).map((q, i) => (
                    <div className="qa" key={i}><div>{q.question}</div><div className="q">{q.why}</div></div>
                  ))}
                </div>
              )}
              {tab === "answers" && fills && (
                <div className="textpane">
                  {fills.map((f) => (
                    <div className="gap" key={f.id}>
                      <span className="need">{f.label}</span>
                      {f.source === "drafted" ? <Link className="pill hi" href="/answers?new=1">{SOURCE_LABEL[f.source]}</Link> : <span className="pill lo">{SOURCE_LABEL[f.source]}</span>}
                      <span className="fix">{f.file ? (f.file === "resume" ? "Tailored resume PDF" : "Cover letter PDF") : Array.isArray(f.value) ? f.value.join(", ") : String(f.value)}</span>
                    </div>
                  ))}
                </div>
              )}
              {tab === "description" && <pre className="plain">{job.descriptionText || "No description provided."}</pre>}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
