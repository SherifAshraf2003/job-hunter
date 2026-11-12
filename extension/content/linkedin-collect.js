// LinkedIn search collection: reads up to `limit` job cards from one search results page, at human pace.
if (!globalThis.JFCollect) {
  globalThis.JFCollect = true;
  const text = (el) => (el ? (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : "");
  const q = (sels, root = document) => { for (const s of sels) { const el = root.querySelector(s); if (el) return el; } return null; };

  async function collect(limit) {
    if (/\/(checkpoint|authwall|login|uas\/login)/.test(location.pathname)) return { blocked: "login_wall", jobs: [] };
    if (/unusual activity|security verification/i.test(document.body.innerText.slice(0, 3000))) return { blocked: "blocked", jobs: [] };
    const list = await JF.waitFor(() => q([".scaffold-layout__list", ".jobs-search-results-list", "ul.scaffold-layout__list-container"]), 15_000);
    if (!list) return { jobs: [] };
    // Scroll the list so lazy cards render.
    for (let i = 0; i < 6; i++) { list.scrollBy?.(0, 600); await JF.sleep(500 + Math.random() * 700); }
    const cards = [...document.querySelectorAll("li[data-occludable-job-id], div.job-card-container[data-job-id]")].slice(0, limit);
    const jobs = [];
    for (const card of cards) {
      const id = card.getAttribute("data-occludable-job-id") || card.getAttribute("data-job-id");
      const link = card.querySelector("a.job-card-container__link, a[href*='/jobs/view/']") || card;
      link.click();
      await JF.sleep(2000 + Math.random() * 4000);
      const pane = q([".jobs-search__job-details--container", ".jobs-details", ".job-view-layout", "main"]);
      const title = text(q([".job-details-jobs-unified-top-card__job-title", ".jobs-unified-top-card__job-title", "h1"], pane));
      const company = text(q([".job-details-jobs-unified-top-card__company-name", ".jobs-unified-top-card__company-name", "a[href*='/company/']"], pane));
      const meta = text(q([".job-details-jobs-unified-top-card__primary-description-container", ".job-details-jobs-unified-top-card__tertiary-description-container", ".jobs-unified-top-card__primary-description"], pane));
      const location = meta.split("·")[0].trim();
      const description = text(q(["#job-details", ".jobs-description__content", ".jobs-box__html-content"], pane));
      const applyBtn = q([".jobs-apply-button", "button[aria-label*='Apply']"], pane);
      const easyApply = /easy apply/i.test(text(applyBtn) + (applyBtn?.getAttribute("aria-label") || ""));
      const salaryText = text(q([".job-details-preferences-and-skills", ".job-details-fit-level-preferences", ".salary"], pane)).slice(0, 200);
      if (id && title && company) jobs.push({ id, title, company, location, description, easyApply, salaryText });
    }
    return { jobs };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type !== "collect") return;
    collect(msg.limit || 10).then(reply, (e) => reply({ error: String(e.message || e), jobs: [] }));
    return true;
  });
}
