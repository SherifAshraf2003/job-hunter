// Greenhouse: boards.greenhouse.io (classic) and job-boards.greenhouse.io (new React boards).
JF.adapter = {
  formRoot() {
    return document.querySelector("#application-form, form#application_form, form[action*='applications'], .application--form form")
      || [...document.querySelectorAll("form")].find((f) => f.querySelector("input[type=file], input[name*='first_name'], #first_name"));
  },
  async openForm() {
    if (this.formRoot()) return;
    const btn = JF.byText("button, a", /^apply( for this job| now)?$/i);
    if (btn) { btn.click(); await JF.sleep(1200); }
  },
  isClosed() {
    const t = document.body.innerText.slice(0, 3000);
    return /no longer (open|available|accepting)|job (is )?not found|position has been filled|page you were looking for/i.test(t) && !this.formRoot();
  },
  async submit() {
    const root = this.formRoot();
    const btn = root.querySelector("button[type=submit], input[type=submit], #submit_app") || JF.byText("button", /submit( application)?/i, root);
    if (!btn) throw new Error("Submit button not found");
    btn.click();
  },
  confirmed() {
    return /\/confirmation/.test(location.pathname) ||
      /thank you for applying|application (has been |was )?(submitted|received)|we('| ha)ve received your application/i.test(document.body.innerText.slice(0, 5000));
  },
};
