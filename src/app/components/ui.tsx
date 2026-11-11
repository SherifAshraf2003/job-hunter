import Link from "next/link";
import type { Weights } from "@/config";
import type { RankedJob } from "@/queries/jobs";

export const DIMS = [
  { key: "scope", label: "Role scope", color: "var(--q1)" },
  { key: "company", label: "Company", color: "var(--q2)" },
  { key: "pay", label: "Pay", color: "var(--q3)" },
  { key: "level", label: "Level match", color: "var(--q4)" },
  { key: "fit", label: "Fit to your resume", color: "var(--fit)" },
] as const;

export const FEAS_LABEL: Record<string, [string, "ok" | "no" | ""]> = {
  in_egypt: ["In Egypt", "ok"],
  remote_from_egypt: ["Remote OK", "ok"],
  sponsors: ["Sponsors", "ok"],
  unclear: ["Unclear", ""],
  not_possible: ["Can't take", "no"],
};

const fmt = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US"));

export function salaryText(j: RankedJob): string | null {
  if (j.salaryMin == null && j.salaryMax == null) return null;
  const lo = j.salaryMin ?? j.salaryMax!, hi = j.salaryMax ?? j.salaryMin!;
  const per = j.salaryPeriod === "month" ? "/mo" : j.salaryPeriod === "hour" ? "/hr" : "/yr";
  const range = lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
  return `${j.salaryCurrency ?? ""} ${range}${per}`.trim();
}

export function ScoreBar({ j, w }: { j: RankedJob; w: Weights }) {
  const total = w.scope + w.company + w.pay + w.level + w.fit || 1;
  if (!j.scores) return <div className="bar" aria-label="Not scored yet" />;
  return (
    <div className="bar" aria-label="Score breakdown">
      {DIMS.map((d) => (
        <span key={d.key} style={{ width: `${((j.scores![d.key] * w[d.key]) / total).toFixed(1)}%`, background: d.color }} />
      ))}
    </div>
  );
}

export function JobRow({ j, i, w, href, current }: { j: RankedJob; i: number; w: Weights; href: string; current: boolean }) {
  const sal = salaryText(j);
  const feas = j.scores ? FEAS_LABEL[j.scores.canTake] : null;
  return (
    <Link className="row" href={href} aria-current={current} scroll={false}>
      <div className="rank">{i + 1}</div>
      <div style={{ minWidth: 0 }}>
        <div className="title">{j.title}</div>
        <div className="co">{j.companyName}{j.location ? `, ${j.location}` : ""}</div>
      </div>
      <div className="scorewrap"><span className="score">{j.composite ?? "–"}</span><ScoreBar j={j} w={w} /></div>
      <div className="sal">
        {sal ?? <span className="none">Not posted</span>}
        {feas && <div className={`feas ${feas[1]}`}>{feas[0]}</div>}
      </div>
      <div className="src">{[...new Set(j.sources.map((s) => s.source))].join(", ")}</div>
    </Link>
  );
}
