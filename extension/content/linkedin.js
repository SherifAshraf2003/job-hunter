// LinkedIn Easy Apply: FILL ONLY. This adapter walks the steps and stops on the review screen.
// It deliberately has no code that clicks "Submit application" (spec: LinkedIn is never auto-submitted).
JF.adapter = {
  blocked() {
    if (/\/(checkpoint|authwall|login|uas\/login|signup)/.test(location.pathname)) return "login_wall";
    if (/unusual activity|security verification|let's do a quick security check/i.test(document.body.innerText.slice(0, 3000))) return "blocked";
    return null;
  },
  formRoot() { return document.querySelector(".jobs-easy-apply-modal, [data-test-modal][role=dialog], div[role=dialog]"); },
  async openForm() {},
  isClosed() { return /no longer accepting applications/i.test(document.body.innerText.slice(0, 6000)); },
  async submit() { throw new Error("LinkedIn is fill-only"); },
  confirmed() { return false; },

  async run({ jobId, pacing }) {
    // Current LinkedIn markup has obfuscated class names: find the apply control by its text or label.
    const isApply = (b) => JF.visible(b) && /^(easy )?apply\b|apply on company website/i.test(`${(b.innerText || "").trim()} ${b.getAttribute("aria-label") || ""}`.trim());
    const applyBtn = await JF.waitFor(() => document.querySelector(".jobs-apply-button") || [...document.querySelectorAll("button, a")].find(isApply), 15_000);
    if (!applyBtn) return JF.done(jobId, { outcome: "needs_you", reason: "No apply button found on LinkedIn" }, true);
    if (!/easy apply/i.test(applyBtn.innerText + applyBtn.getAttribute("aria-label"))) {
      return JF.done(jobId, { outcome: "needs_you", reason: "Applies on company site: open it from LinkedIn" }, true);
    }
    applyBtn.click();
    const modal = await JF.waitFor(() => this.formRoot(), 10_000);
    if (!modal) return JF.done(jobId, { outcome: "needs_you", reason: "Easy Apply window did not open" }, true);
    let lastPlan = null;
    for (let step = 0; step < 10; step++) {
      await JF.sleep(1200);
      if (this.blocked()) return JF.done(jobId, { outcome: this.blocked() }, true);
      const root = this.formRoot();
      if (!root) return JF.done(jobId, { outcome: "needs_you", reason: "Easy Apply window closed unexpectedly" }, true);
      const fields = await JF.extractFields(root);
      if (fields.length) {
        lastPlan = await JF.send({ type: "plan", jobId, fields });
        await JF.fill(jobId, lastPlan.fills, pacing);
        if (lastPlan.reason && lastPlan.reason !== "LinkedIn: review and submit") {
          return JF.done(jobId, { outcome: "stopped", status: "needs_you", reason: lastPlan.reason }, true);
        }
        const empty = JF.requiredEmpty();
        if (empty.length) return JF.done(jobId, { outcome: "needs_you", reason: `LinkedIn: could not fill ${empty.join(", ")}` }, true);
      }
      const buttons = [...root.querySelectorAll("button")].filter(JF.visible);
      const label = (b) => `${b.innerText} ${b.getAttribute("aria-label") || ""}`;
      // The last screen: stop here and hand over to Sherif.
      if (buttons.some((b) => /submit application/i.test(label(b)))) {
        return JF.done(jobId, { outcome: "stopped", status: "needs_you", reason: "LinkedIn: review and submit" }, true);
      }
      const next = buttons.find((b) => /^(next|review|continue)\b|continue to next step|review your application/i.test(label(b).trim()));
      if (!next) return JF.done(jobId, { outcome: "needs_you", reason: "LinkedIn: could not find the Next button" }, true);
      next.click();
    }
    return JF.done(jobId, { outcome: "needs_you", reason: "LinkedIn: too many steps" }, true);
  },
};
