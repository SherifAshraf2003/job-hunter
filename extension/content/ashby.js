// Ashby: jobs.ashbyhq.com/{company}/{id}/application (opened directly by the background).
JF.adapter = {
  formRoot() {
    return document.querySelector("[class*='application-form'], form[class*='ashby'], #form")
      || [...document.querySelectorAll("form, [role=form], main")].find((f) => f.querySelector("input[type=file], input[name='_systemfield_name'], #_systemfield_name"));
  },
  async openForm() {
    if (!this.formRoot()) {
      const tab = JF.byText("a, button, [role=tab]", /^application$/i);
      if (tab) { tab.click(); await JF.sleep(1500); }
    }
    // The "Autofill from resume" upload would overwrite answers with Ashby's own parsing: leave it alone.
    for (const el of document.querySelectorAll("input[type=file]")) {
      const box = el.closest("div");
      if (box && /autofill/i.test(box.closest("[class*='autofill'], section, div")?.innerText || "")) box.setAttribute("data-jf-skip", "1");
    }
  },
  isClosed() {
    const t = document.body.innerText.slice(0, 2000);
    return !this.formRoot() && /job not found|no longer (open|accepting|available)|this posting (is )?closed|page not found/i.test(t);
  },
  async submit() {
    const btn = JF.byText("button", /^submit( application)?$/i) || document.querySelector("button[type=submit]");
    if (!btn) throw new Error("Submit button not found");
    btn.click();
  },
  confirmed() {
    return /thanks for applying|application (was )?(successfully )?submitted|we('ve| have) received your application/i.test(document.body.innerText.slice(0, 4000));
  },
};
