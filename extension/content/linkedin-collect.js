// LinkedIn search collection: reads up to `limit` job cards from one search results page, at human pace.
// Works on the current search page (/jobs/search-results/, obfuscated class names): cards are
// [role=button][componentkey="job-card-component-ref-<id>"]. The job description isn't rendered in a background
// tab (it loads on scroll), so it's read from LinkedIn's public logged-out job page instead.
if (!globalThis.JFCollect) {
  globalThis.JFCollect = true;
  const lines = (el) => (el?.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const CARD = "[role=button][componentkey^='job-card-component-ref-'], li[data-occludable-job-id], div.job-card-container[data-job-id]";
  const cardId = (c) => (c.getAttribute("componentkey") || "").replace("job-card-component-ref-", "") || c.getAttribute("data-occludable-job-id") || c.getAttribute("data-job-id");

  /** The posting's description from the logged-out job page (no account traffic). */
  async function description(id) {
    try {
      const html = await (await fetch(`/jobs-guest/jobs/api/jobPosting/${id}`, { credentials: "omit" })).text();
      const m = html.match(/<div class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      if (!m) return "";
      const doc = new DOMParser().parseFromString(`<div>${m[1].replace(/<br\s*\/?>/g, "\n").replace(/<\/(p|li|h\d)>/g, "\n")}</div>`, "text/html");
      return (doc.body.textContent || "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    } catch { return ""; }
  }

  /** The company's own apply URL from LinkedIn's redirect link, if the job applies off LinkedIn. */
  function externalUrl() {
    const a = document.querySelector("a[aria-label*='company website']");
    if (!a) return "";
    try {
      const u = new URL(a.href);
      return u.searchParams.get("url") || a.href;
    } catch { return ""; }
  }

  async function collect(limit) {
    if (/\/(checkpoint|authwall|login|uas\/login)/.test(location.pathname)) return { blocked: "login_wall", jobs: [] };
    if (/unusual activity|security verification/i.test(document.body.innerText.slice(0, 3000))) return { blocked: "blocked", jobs: [] };
    const first = await JF.waitFor(() => document.querySelector(CARD), 20_000);
    if (!first) return { jobs: [] };
    const cards = [...document.querySelectorAll(CARD)].slice(0, limit);
    const jobs = [];
    for (const card of cards) {
      const id = (cardId(card) || "").replace(/\D/g, "");
      const [title, company, location] = lines(card);
      if (!id || !title || !company) continue;
      card.click();
      await JF.sleep(2000 + Math.random() * 3000);
      const easyApply = [...document.querySelectorAll("button, a")].some((b) => !card.contains(b) && /easy apply/i.test(`${b.innerText || ""} ${b.getAttribute("aria-label") || ""}`));
      const applyUrl = easyApply ? "" : externalUrl();
      const desc = await description(id);
      jobs.push({ id, title, company, location: location || "", description: desc, easyApply, applyUrl });
    }
    return { jobs };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type !== "collect") return;
    collect(msg.limit || 10).then(reply, (e) => reply({ error: String(e.message || e), jobs: [] }));
    return true;
  });
}
