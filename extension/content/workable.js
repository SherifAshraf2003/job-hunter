// Workable: apply.workable.com/{company}/j/{id}/apply/ (opened directly by the background).
JF.adapter = {
  formRoot() {
    return document.querySelector("form[data-ui='application-form'], form[class*='application']")
      || [...document.querySelectorAll("form")].find((f) => f.querySelector("input[type=file], input[name='email'], input[name='firstname']"));
  },
  async openForm() {
    if (this.formRoot()) return;
    const btn = document.querySelector("[data-ui='apply-button'], a[data-ui='overview-apply-now']") || JF.byText("a, button", /apply for this job|apply now/i);
    if (btn) { btn.click(); await JF.sleep(1500); }
    // Workable asks for cookie consent first; decline non-essential cookies.
    const decline = JF.byText("button", /^(decline|reject)( all)?( cookies)?$/i);
    if (decline) { decline.click(); await JF.sleep(500); }
  },
  isClosed() {
    const t = document.body.innerText.slice(0, 2000);
    return !this.formRoot() && /no longer (available|accepting|open)|job (is )?not found|position (has been )?(filled|closed)/i.test(t);
  },
  async submit() {
    const btn = document.querySelector("button[data-ui='apply-button'][type=submit], form button[type=submit]") || JF.byText("button", /submit( application)?/i);
    if (!btn) throw new Error("Submit button not found");
    btn.click();
  },
  confirmed() {
    return /application (has been )?submitted|thank you for (applying|your application)|we('ve| have) received your application/i.test(document.body.innerText.slice(0, 4000));
  },
};
