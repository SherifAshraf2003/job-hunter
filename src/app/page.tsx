import Link from "next/link";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs } from "@/db/schema";
import { loadSettings } from "@/config";
import { listJobs, getJob, stageCounts, latestRun, sourceCount, type JobFilters } from "@/queries/jobs";
import { spendSummary } from "@/budget/budget";
import { DIMS, FEAS_LABEL, JobRow, salaryText } from "./components/ui";
import { RunNow } from "./components/RunNow";

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
  revalidatePath("/");
}

export default async function Home({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const cfg = await loadSettings();
  const filters: JobFilters = {
    stage: (sp.stage as JobFilters["stage"]) ?? "scored",
    canTake: sp.canTake === "1", salaryPosted: sp.salaryPosted === "1", ai: sp.ai === "1",
    founding: sp.founding === "1", remote: sp.remote === "1",
    minScore: sp.minScore ? Number(sp.minScore) : undefined,
  };
  const [list, counts, run, spend, nSources] = await Promise.all([
    listJobs(filters, cfg.weights), stageCounts(), latestRun(), spendSummary(), sourceCount(),
  ]);
  const selectedId = sp.job ? Number(sp.job) : list[0]?.id;
  const job = selectedId ? await getJob(selectedId, cfg.weights) : null;
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
          <RunNow />
          <Link className="btn" href="/settings">Settings</Link>
        </div>
      </header>

      <nav className="stages" aria-label="Pipeline stage">
        {STAGES.map((s) => (
          <Link key={s.key} className={`stage ${s.key === "score_failed" && counts.failed ? "warn" : ""}`}
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
            <div className="actions">
              <a className="btn primary" href={job.applyUrl} target="_blank" rel="noreferrer">View listing</a>
              {job.status !== "filtered_out" && (
                <form action={skipJob}><input type="hidden" name="id" value={job.id} /><button className="btn" type="submit">Skip job</button></form>
              )}
            </div>
            <div className="desc">
              <h2>Job description</h2>
              <pre>{job.descriptionText || "No description provided."}</pre>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
