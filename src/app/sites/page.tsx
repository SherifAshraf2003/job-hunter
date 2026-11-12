import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { sites } from "@/db/schema";
import { loadSettings, saveSetting } from "@/config";
import { getExtensionToken, regenerateExtensionToken } from "@/app/api/ext/auth";
import { CopyButton } from "@/app/components/CopyButton";

export const dynamic = "force-dynamic";

const SITES = [
  { site: "greenhouse", label: "Greenhouse" }, { site: "lever", label: "Lever" }, { site: "ashby", label: "Ashby" },
  { site: "workable", label: "Workable" }, { site: "linkedin", label: "LinkedIn" },
] as const;
type SiteKey = (typeof SITES)[number]["site"];

const int = (v: FormDataEntryValue | null, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? Math.min(max, Math.max(min, n)) : dflt;
};

async function saveSite(fd: FormData) {
  "use server";
  const site = String(fd.get("site")) as SiteKey;
  if (!SITES.some((s) => s.site === site)) return;
  const capRaw = String(fd.get("dailyCap") ?? "").trim();
  const values = {
    site,
    autoSubmit: site === "linkedin" ? false : fd.get("autoSubmit") === "on",
    dailyCap: capRaw ? int(capRaw, 0, 500, 0) : null,
  };
  await db.insert(sites).values(values).onConflictDoUpdate({ target: sites.site, set: values });
  redirect("/sites?ok=site");
}

async function pauseSite(fd: FormData) {
  "use server";
  const site = String(fd.get("site")) as SiteKey;
  const paused = fd.get("paused") === "1";
  if (!SITES.some((s) => s.site === site)) return;
  const set = { paused, pauseReason: paused ? "Paused by you" : null, pausedAt: paused ? new Date() : null };
  await db.insert(sites).values({ site, autoSubmit: site !== "linkedin", ...set }).onConflictDoUpdate({ target: sites.site, set });
  redirect("/sites");
}

async function saveCaps(fd: FormData) {
  "use server";
  const cfg = await loadSettings();
  await saveSetting("caps", {
    linkedinDaily: int(fd.get("linkedinDaily"), 0, 100, cfg.caps.linkedinDaily),
    perBoardDaily: int(fd.get("perBoardDaily"), 0, 50, cfg.caps.perBoardDaily),
    globalDaily: int(fd.get("globalDaily"), 0, 500, cfg.caps.globalDaily),
    perCompany30d: int(fd.get("perCompany30d"), 0, 20, cfg.caps.perCompany30d),
  });
  const fMin = int(fd.get("fieldMin"), 100, 10_000, 400), fMax = int(fd.get("fieldMax"), 100, 20_000, 1500);
  const aMin = int(fd.get("appMin"), 10, 3600, 90), aMax = int(fd.get("appMax"), 10, 7200, 240);
  await saveSetting("pacing", { fieldMs: [Math.min(fMin, fMax), Math.max(fMin, fMax)], betweenAppsSec: [Math.min(aMin, aMax), Math.max(aMin, aMax)] });
  redirect("/sites?ok=caps");
}

async function toggle(fd: FormData) {
  "use server";
  const key = String(fd.get("key"));
  const on = fd.get("on") === "1";
  if (key === "globalPause") await saveSetting("globalPause", on);
  if (key === "dryRun") await saveSetting("dryRun", on);
  if (key === "trust") await saveSetting("trustRemaining", 10);
  if (key === "token") await regenerateExtensionToken();
  redirect("/sites");
}

export default async function Sites({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const cfg = await loadSettings();
  const rows = await db.select().from(sites);
  const token = await getExtensionToken();
  const okMsg = { site: "Site saved.", caps: "Caps and pacing saved." }[sp.ok ?? ""];
  const flip = (key: string, on: boolean, label: string, primary = false) => (
    <form action={toggle}><input type="hidden" name="key" value={key} /><input type="hidden" name="on" value={on ? "1" : "0"} />
      <button className={`btn ${primary ? "primary" : ""}`} type="submit">{label}</button></form>
  );

  return (
    <div className="app">
      <header className="top">
        <Link className="brand" href="/">Job Finder</Link>
        <div className="today"><Link className="btn" href="/answers">Answers</Link><Link className="btn" href="/">Back to jobs</Link></div>
      </header>
      {okMsg && <p className="ok" role="status">{okMsg}</p>}

      <section className="panel">
        <h2>Applying</h2>
        <div className="field"><span>All applying</span><b>{cfg.globalPause ? "Paused" : "Running"}</b>
          <small>{flip("globalPause", !cfg.globalPause, cfg.globalPause ? "Resume applying" : "Pause everything", !cfg.globalPause)}</small></div>
        <div className="field"><span>Dry run</span><b>{cfg.dryRun ? "On" : "Off"}</b>
          <small>{cfg.dryRun
            ? <>The extension fills forms but never submits. Off means the extension really submits applications. {flip("dryRun", false, "Turn dry run off")}</>
            : <>The extension submits applications for real. {flip("dryRun", true, "Turn dry run on")}</>}</small></div>
        <div className="field"><span>Trust period</span><b>{cfg.trustRemaining} approvals left</b>
          <small>Until then, every auto-submit waits in Ready to submit for your click. {flip("trust", true, "Restart trust period")}</small></div>
      </section>

      <section className="panel">
        <h2>Sites</h2>
        <p className="hint">Paused sites are skipped. The extension pauses a site by itself after 3 captchas in an hour, an unusual-activity page, or a logout.</p>
        {SITES.map(({ site, label }) => {
          const r = rows.find((x) => x.site === site);
          const auto = site === "linkedin" ? false : r?.autoSubmit ?? true;
          return (
            <div key={site} className="field" style={{ gridTemplateColumns: "140px 1fr auto" }}>
              <span>{label}{r?.paused ? <> <span className="pill hi">Paused{r.pauseReason ? `: ${r.pauseReason}` : ""}</span></> : null}</span>
              <form action={saveSite} style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <input type="hidden" name="site" value={site} />
                {site === "linkedin"
                  ? <small>Fill only: you click Submit</small>
                  : <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" name="autoSubmit" defaultChecked={auto} /> Auto-submit</label>}
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>Daily cap
                  <input name="dailyCap" type="number" min="0" style={{ width: 70 }} defaultValue={r?.dailyCap ?? ""} placeholder={site === "linkedin" ? String(cfg.caps.linkedinDaily) : "none"} /></label>
                <button className="btn" type="submit">Save</button>
              </form>
              <form action={pauseSite}><input type="hidden" name="site" value={site} /><input type="hidden" name="paused" value={r?.paused ? "0" : "1"} />
                <button className="btn" type="submit">{r?.paused ? "Resume" : "Pause"}</button></form>
            </div>
          );
        })}
      </section>

      <form className="panel" action={saveCaps}>
        <h2>Caps and pacing</h2>
        <label className="field"><span>LinkedIn forms per day</span><input name="linkedinDaily" type="number" min="0" defaultValue={cfg.caps.linkedinDaily} /><small>Filled forms, since you submit them</small></label>
        <label className="field"><span>Per company board per day</span><input name="perBoardDaily" type="number" min="0" defaultValue={cfg.caps.perBoardDaily} /><small>Greenhouse, Lever, Ashby, Workable</small></label>
        <label className="field"><span>All applications per day</span><input name="globalDaily" type="number" min="0" defaultValue={cfg.caps.globalDaily} /><small>Across every company board</small></label>
        <label className="field"><span>Same company per 30 days</span><input name="perCompany30d" type="number" min="0" defaultValue={cfg.caps.perCompany30d} /><small>Its best-scoring roles go first</small></label>
        <label className="field"><span>Pause between fields (ms)</span>
          <span style={{ display: "flex", gap: 6 }}><input name="fieldMin" type="number" defaultValue={cfg.pacing.fieldMs[0]} /><input name="fieldMax" type="number" defaultValue={cfg.pacing.fieldMs[1]} /></span><small>Random in this range</small></label>
        <label className="field"><span>Pause between jobs (seconds)</span>
          <span style={{ display: "flex", gap: 6 }}><input name="appMin" type="number" defaultValue={cfg.pacing.betweenAppsSec[0]} /><input name="appMax" type="number" defaultValue={cfg.pacing.betweenAppsSec[1]} /></span><small>Random in this range</small></label>
        <button className="btn primary" type="submit">Save caps and pacing</button>
      </form>

      <section className="panel">
        <h2>Extension</h2>
        <p className="hint">Paste this token into the Job Finder Apply extension once. Regenerating it disconnects the extension until you paste the new one.</p>
        <div className="field" style={{ gridTemplateColumns: "1fr auto auto" }}>
          <code style={{ overflowWrap: "anywhere", fontSize: 12 }}>{token.slice(0, 6)}…{token.slice(-4)}</code>
          <CopyButton text={token} label="Copy token" />
          {flip("token", true, "Regenerate")}
        </div>
      </section>
    </div>
  );
}
