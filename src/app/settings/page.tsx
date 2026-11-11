import Link from "next/link";
import { redirect } from "next/navigation";
import { loadSettings, saveSetting, type Weights } from "@/config";
import { loadProfile, saveProfile, parseResumeFile } from "@/profile/load";
import type { BaseProfile } from "@/profile/types";

export const dynamic = "force-dynamic";

const WEIGHT_FIELDS: { key: keyof Weights; label: string }[] = [
  { key: "scope", label: "Role scope" },
  { key: "company", label: "Company" },
  { key: "pay", label: "Pay" },
  { key: "level", label: "Level match" },
  { key: "fit", label: "Fit to your resume" },
];

async function saveRanking(fd: FormData) {
  "use server";
  const raw = Object.fromEntries(WEIGHT_FIELDS.map((f) => [f.key, Math.max(0, Number(fd.get(f.key)) || 0)])) as Weights;
  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  if (total <= 0) redirect("/settings?err=" + encodeURIComponent("At least one weight must be above zero."));
  const weights = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Math.round((v / total) * 1000) / 1000])) as Weights;
  await saveSetting("weights", weights);
  await saveSetting("cutoff", Math.min(100, Math.max(0, Number(fd.get("cutoff")) || 60)));
  await saveSetting("searchIntervalHours", Math.min(48, Math.max(1, Number(fd.get("searchIntervalHours")) || 4)));
  await saveSetting("budgetUsdMonthly", Math.max(1, Number(fd.get("budgetUsdMonthly")) || 10));
  redirect("/settings?ok=ranking");
}

async function saveProfileAction(fd: FormData) {
  "use server";
  let p: BaseProfile;
  try {
    p = JSON.parse(String(fd.get("profile")));
  } catch (e) {
    redirect("/settings?err=" + encodeURIComponent(`Profile isn't valid JSON: ${(e as Error).message}`));
  }
  if (!Array.isArray(p!.roles) || typeof p!.skills !== "object" || p!.skills === null) {
    redirect("/settings?err=" + encodeURIComponent("Profile needs a \"roles\" list and a \"skills\" object."));
  }
  await saveProfile(p!);
  redirect("/settings?ok=profile");
}

async function reimport() {
  "use server";
  await saveProfile(parseResumeFile());
  redirect("/settings?ok=reimported");
}

export default async function Settings({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const cfg = await loadSettings();
  const profile = await loadProfile();
  const okMsg = { ranking: "Ranking settings saved. The list re-ranks right away.", profile: "Profile saved.", reimported: "Profile re-imported from resume.tex." }[sp.ok ?? ""];

  return (
    <div className="app">
      <header className="top">
        <Link className="brand" href="/">Job Finder</Link>
        <div className="today"><Link className="btn" href="/">Back to jobs</Link></div>
      </header>
      {sp.err && <p className="err" role="alert">{sp.err}</p>}
      {okMsg && <p className="ok" role="status">{okMsg}</p>}

      <form className="panel" action={saveRanking}>
        <h2>Ranking</h2>
        <p className="hint">Weights are saved as shares of 100%. Job quality should outweigh fit.</p>
        {WEIGHT_FIELDS.map((f) => (
          <label className="field" key={f.key}>
            <span>{f.label}</span>
            <input name={f.key} type="number" step="0.01" min="0" defaultValue={cfg.weights[f.key]} />
            <small>{Math.round(cfg.weights[f.key] * 100)}% now</small>
          </label>
        ))}
        <label className="field"><span>Score cutoff</span><input name="cutoff" type="number" min="0" max="100" defaultValue={cfg.cutoff} /><small>Used for tailoring in Phase 2</small></label>
        <label className="field"><span>Search every (hours)</span><input name="searchIntervalHours" type="number" min="1" max="48" defaultValue={cfg.searchIntervalHours} /><small>Takes effect after the next search</small></label>
        <label className="field"><span>Monthly AI budget ($)</span><input name="budgetUsdMonthly" type="number" min="1" step="1" defaultValue={cfg.budgetUsdMonthly} /><small>Half is reserved for tailoring</small></label>
        <button className="btn primary" type="submit">Save ranking settings</button>
      </form>

      <form className="panel" action={saveProfileAction}>
        <h2>Base profile</h2>
        <p className="hint">Everything the scoring sees about you. Only facts in here are ever used.</p>
        <textarea className="json" name="profile" defaultValue={JSON.stringify(profile, null, 2)} spellCheck={false} aria-label="Base profile JSON" />
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className="btn primary" type="submit">Save profile</button>
          <button className="btn" formAction={reimport} type="submit">Re-import from resume.tex</button>
        </div>
      </form>
    </div>
  );
}
