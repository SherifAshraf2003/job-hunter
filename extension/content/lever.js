// Lever: the form lives at jobs.lever.co/{company}/{id}/apply (the background opens that URL directly).
JF.adapter = {
  formRoot() {
    return document.querySelector("form#application-form, form[action*='/apply'], .application-form form, .postings-form")
      || [...document.querySelectorAll("form")].find((f) => f.querySelector("input[name='resume'], input[name='email']"));
  },
  async openForm() {
    if (this.formRoot()) return;
    const link = JF.byText("a, button", /^apply( for this job)?$/i);
    if (link) { link.click(); await JF.sleep(1500); }
  },
  isClosed() {
    const t = document.body.innerText.slice(0, 2000);
    return !this.formRoot() && /couldn't find anything here|no longer (open|accepting|available)|page not found|404/i.test(t);
  },
  async submit() {
    const btn = document.querySelector("#btn-submit, button[type=submit].postings-btn, button[data-qa='btn-submit']") || JF.byText("button", /submit application/i);
    if (!btn) throw new Error("Submit button not found");
    btn.click();
  },
  confirmed() {
    return /\/thanks\/?$/.test(location.pathname) || /application submitted|thanks for applying|we've received your application/i.test(document.body.innerText.slice(0, 4000));
  },
};
