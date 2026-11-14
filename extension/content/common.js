// Shared form reading and filling. Injected before the site adapter, which sets JF.adapter:
// { formRoot(): Element|null, openForm(): Promise<void>, isClosed(): boolean, submit(): Promise<void>, confirmed(): boolean }
if (!globalThis.JF) {
  const JF = (globalThis.JF = { adapter: null });

  // Background tabs throttle page timers (1s minimum, then once a minute), so pauses are timed by the
  // extension's service worker instead and delivered as a message reply.
  const sleep = (ms) => new Promise((r) => chrome.runtime.sendMessage({ type: "sleep", ms: Math.round(ms) }, () => { void chrome.runtime.lastError; r(); }));
  const rand = ([a, b]) => a + Math.random() * (b - a);
  const clean = (s) => (s || "").replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").trim();
  const send = (msg) => new Promise((resolve, reject) => chrome.runtime.sendMessage(msg, (r) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (r && r.error) return reject(new Error(r.error));
    resolve(r);
  }));
  JF.sleep = sleep;
  JF.send = send;

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  JF.visible = visible;

  /** Waits for a selector or predicate to produce an element. */
  JF.waitFor = async (fnOrSel, ms = 10_000) => {
    const t0 = Date.now();
    for (;;) {
      const el = typeof fnOrSel === "string" ? document.querySelector(fnOrSel) : fnOrSel();
      if (el) return el;
      if (Date.now() - t0 > ms) return null;
      await sleep(250);
    }
  };

  JF.byText = (selector, re, root = document) =>
    [...root.querySelectorAll(selector)].find((el) => visible(el) && re.test(clean(el.innerText || el.value || el.getAttribute("aria-label") || "")));

  function textOf(el) { return el ? clean(el.innerText || el.textContent) : ""; }

  /** The question text for a control: <label for>, aria-labelledby, aria-label, fieldset legend, or a nearby label. */
  function labelFor(el) {
    if (el.labels && el.labels.length) {
      const t = textOf(el.labels[0]);
      // Radios and checkboxes are labeled by their option text; the question is on the group.
      if (t && !["radio", "checkbox"].includes(el.type)) return t;
    }
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(" "));
      if (t) return t;
    }
    const aria = el.getAttribute("aria-label");
    if (aria && !["radio", "checkbox"].includes(el.type)) return clean(aria);
    const fs = el.closest("fieldset");
    if (fs) { const lg = fs.querySelector("legend"); if (lg && textOf(lg)) return textOf(lg); }
    // Walk up a few containers looking for a label-like element that isn't an option label.
    let node = el.parentElement;
    for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
      const cand = node.querySelector(":scope > label, :scope > .label, :scope > legend, :scope > [class*='label'], :scope > [class*='question'], :scope > p, :scope > h3, :scope > h4, :scope > span");
      if (cand && !cand.contains(el) && textOf(cand)) return textOf(cand);
    }
    return clean(el.getAttribute("placeholder") || el.name || "");
  }

  function isRequired(el, label) {
    return !!(el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(label) ||
      el.closest("fieldset")?.getAttribute("aria-required") === "true");
  }

  const KIND = { email: "email", tel: "tel", url: "url", number: "number", date: "date", file: "file", radio: "radio", checkbox: "checkbox" };

  /** Reads every fillable field under root. Each field's element gets data-jf-id so fill() can find it. */
  JF.extractFields = async (root) => {
    JF.registry = {};
    const fields = [];
    const groups = {};
    let n = 0;
    const controls = [...root.querySelectorAll("input, textarea, select, [role=combobox]")];
    for (const el of controls) {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (el.tagName === "INPUT" && ["hidden", "submit", "button", "reset", "image", "search"].includes(type)) continue;
      if (el.disabled || el.closest("[data-jf-skip]")) continue;
      // Hidden "required" shims that custom selects keep for native validation.
      if (el.getAttribute("aria-hidden") === "true" && el.getAttribute("tabindex") === "-1") continue;
      if (type !== "file" && !visible(el) && !["radio", "checkbox"].includes(type)) continue;
      // A combobox wrapper and its inner input: keep one.
      if (el.getAttribute("role") === "combobox" && el.tagName !== "INPUT" && el.querySelector("input")) continue;

      if (type === "radio" || type === "checkbox") {
        const name = el.name || el.closest("[role=radiogroup], [role=group], fieldset")?.id || `g${n}`;
        const key = `${type}:${name}`;
        if (!groups[key]) {
          const id = `jf${n++}`;
          const groupEl = el.closest("fieldset, [role=radiogroup], [role=group]") || el.parentElement?.parentElement || el;
          let label = labelFor(el);
          const optionLabel = el.labels?.[0] ? textOf(el.labels[0]) : "";
          if (!label || label === optionLabel) label = textOf(groupEl.querySelector("legend, label:not(:has(input)), [class*='label'], [class*='question']")) || optionLabel;
          groups[key] = { id, label: clean(label), kind: type, required: isRequired(el, label), options: [], els: [] };
          fields.push(groups[key]);
        }
        const g = groups[key];
        g.els.push(el);
        el.dataset.jfId = g.id;
        g.options.push(el.labels?.[0] ? textOf(el.labels[0]) : clean(el.value));
        continue;
      }

      const id = `jf${n++}`;
      el.dataset.jfId = id;
      let label = labelFor(el);
      if (type === "file" && (!label || /^(attach|upload|choose file|browse|drop)/i.test(label))) {
        const hint = `${el.id} ${el.name} ${el.getAttribute("aria-describedby") || ""}`;
        label = /cover/i.test(hint) ? "Cover letter" : /resume|cv/i.test(hint) ? "Resume/CV" : label;
      }
      let kind = el.tagName === "TEXTAREA" ? "textarea" : el.tagName === "SELECT" ? "select" : KIND[type] || "text";
      let options;
      if (el.tagName === "SELECT") options = [...el.options].filter((o) => o.value !== "" && !/^select|^choose|^--/i.test(o.text)).map((o) => clean(o.text));
      else if (el.getAttribute("role") === "combobox") { kind = "select"; options = await comboOptions(el); }
      fields.push({ id, label: clean(label), kind, required: isRequired(el, label), options, els: [el] });
    }
    // A single checkbox (e.g. a consent box) is a yes/no question, not a multi-select.
    for (const f of fields) if (f.kind === "checkbox" && f.els.length === 1) f.options = undefined;
    for (const f of fields) JF.registry[f.id] = f;
    return fields.filter((f) => f.label).map(({ els, ...f }) => f);
  };

  /** Opens a custom combobox to read its options, then closes it. Async-search comboboxes return []. */
  /** The listbox that belongs to this combobox only (never another field's menu left open). */
  function ownList(el) {
    const id = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
    if (id && document.getElementById(id)) return document.getElementById(id);
    if (el.id && document.getElementById(`react-select-${el.id}-listbox`)) return document.getElementById(`react-select-${el.id}-listbox`);
    let node = el.parentElement;
    for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
      const l = node.querySelector("[role=listbox]");
      if (l) return l;
    }
    return null;
  }

  function openCombo(el) {
    const control = el.closest("[class*='control']") || el.parentElement;
    control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, bubbles: true }));
  }

  function closeCombo(el) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    el.blur();
  }

  /** Opens a custom combobox to read its options, then closes it. Async-search comboboxes return []. */
  async function comboOptions(el) {
    try {
      openCombo(el);
      await sleep(400);
      const list = ownList(el);
      const opts = list ? [...list.querySelectorAll("[role=option]")].map(textOf).filter(Boolean) : [];
      closeCombo(el);
      await sleep(150);
      return opts.slice(0, 200);
    } catch { return []; }
  }

  /** Sets a value the way React and Vue notice: native setter, then input/change/blur events. */
  function setValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();

  async function fillCombo(el, value) {
    openCombo(el);
    setValue(el, value);
    for (let i = 0; i < 12; i++) {
      await sleep(300);
      const list = ownList(el);
      const opts = list ? [...list.querySelectorAll("[role=option]")] : [];
      const hit = opts.find((o) => same(textOf(o), value)) || opts.find((o) => textOf(o).toLowerCase().includes(String(value).toLowerCase()));
      if (hit) { hit.click(); await sleep(200); return true; }
    }
    closeCombo(el);
    return false;
  }

  async function fillFile(el, jobId, kind) {
    const { name, base64 } = await send({ type: "getFile", jobId, kind });
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: "application/pdf" }));
    el.files = dt.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(800);
  }

  /** Fills every planned field at human pace. Returns the labels it couldn't set. */
  JF.fill = async (jobId, fills, pacing) => {
    const unfilled = [];
    for (const f of fills) {
      const field = JF.registry[f.id];
      if (!field) { unfilled.push(f.label); continue; }
      const el = field.els[0];
      try {
        el.scrollIntoView({ block: "center" });
        if (f.file) await fillFile(el, jobId, f.file);
        else if (field.kind === "radio" || (field.kind === "checkbox" && field.els.length > 1)) {
          const wanted = Array.isArray(f.value) ? f.value : [f.value];
          let any = false;
          field.els.forEach((r, i) => { if (wanted.some((w) => same(field.options[i], w)) && !r.checked) { r.click(); any = true; } else if (wanted.some((w) => same(field.options[i], w))) any = true; });
          if (!any) unfilled.push(f.label);
        } else if (field.kind === "checkbox") {
          const on = f.value === true || /^(yes|true|i agree|agree)/i.test(String(f.value));
          if (el.checked !== on) el.click();
        } else if (el.tagName === "SELECT") {
          const opt = [...el.options].find((o) => same(o.text, f.value)) || [...el.options].find((o) => same(o.value, f.value));
          if (opt) setValue(el, opt.value); else unfilled.push(f.label);
        } else if (el.getAttribute("role") === "combobox") {
          if (!(await fillCombo(el, String(f.value)))) unfilled.push(f.label);
        } else {
          el.focus();
          setValue(el, String(f.value));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        }
      } catch { unfilled.push(f.label); }
      await sleep(rand(pacing?.fieldMs || [400, 1500]));
    }
    return unfilled;
  };

  /** Labels of required fields that are still empty after filling. */
  JF.requiredEmpty = () => Object.values(JF.registry || {}).filter((f) => f.required).filter((f) => {
    const el = f.els[0];
    if (f.kind === "radio" || f.kind === "checkbox") return !f.els.some((e) => e.checked);
    if (f.kind === "file") return !(el.files && el.files.length) && !el.closest("form")?.querySelector("[class*='file'] [class*='name'], [data-testid*='file-name']");
    if (el.getAttribute("role") === "combobox") {
      const control = el.closest("[class*='control']") || el.parentElement;
      return !clean(el.value) && !control?.querySelector("[class*='single-value'], [class*='multi-value'], [class*='singleValue']");
    }
    return !clean(el.value);
  }).map((f) => f.label);

  /** A captcha the user has to solve (visible), not the invisible reCAPTCHA most ATS forms load. */
  JF.captchaPresent = () => [...document.querySelectorAll("iframe")].some((f) => {
    const src = f.src || "";
    if (!/recaptcha|hcaptcha|challenges\.cloudflare|turnstile/.test(src) || /size=invisible/.test(src)) return false;
    const r = f.getBoundingClientRect();
    return visible(f) && r.width > 60 && r.height > 60;
  });

  const done = (jobId, report, keepOpen) => send({ type: "done", jobId, report, keepOpen });
  JF.done = done;

  async function confirmLoop(jobId) {
    for (let i = 0; i < 40; i++) {
      if (JF.adapter.confirmed()) return done(jobId, { outcome: "applied" }, false);
      if (JF.captchaPresent()) return done(jobId, { outcome: "captcha" }, true);
      await sleep(500);
    }
    return done(jobId, { outcome: "needs_you", reason: "No confirmation after submit: check the tab" }, true);
  }

  /** The whole flow on one page. Every exit reports exactly once. */
  JF.run = async ({ jobId, mode, pacing }) => {
    // A second "run" for the same page (two load events) must not fill or submit twice.
    if (JF.running) return;
    JF.running = true;
    const a = JF.adapter;
    try {
      await sleep(1500);
      if (a.blocked?.()) return done(jobId, { outcome: a.blocked() }, true);
      if (a.isClosed()) return done(jobId, { outcome: "closed" }, false);
      if (a.run) return await a.run({ jobId, mode, pacing });
      await a.openForm();
      const root = await JF.waitFor(() => a.formRoot(), 15_000);
      if (!root) return done(jobId, { outcome: "needs_you", reason: "Could not find the application form" }, true);
      const fields = await JF.extractFields(root);
      const plan = await send({ type: "plan", jobId, fields });
      const unfilled = await JF.fill(jobId, plan.fills, pacing);
      if (JF.captchaPresent()) return done(jobId, { outcome: "captcha" }, true);
      const empty = JF.requiredEmpty();
      if (plan.action === "stop") {
        const reason = [plan.reason, empty.length ? `Not filled: ${empty.join(", ")}` : ""].filter(Boolean).join(". ");
        return done(jobId, { outcome: "stopped", status: plan.status, reason: reason || null }, true);
      }
      if (empty.length || unfilled.length) {
        return done(jobId, { outcome: "needs_you", reason: `Could not fill: ${[...new Set([...empty, ...unfilled])].join(", ")}` }, true);
      }
      if (mode !== "submit" && plan.status !== "applied_pending") return done(jobId, { outcome: "stopped", status: plan.status, reason: plan.reason }, true);
      await send({ type: "submitting", jobId });
      await sleep(rand([800, 2000]));
      await a.submit();
      JF.confirming = true;
      return confirmLoop(jobId);
    } catch (e) {
      return done(jobId, { outcome: "failed", reason: String(e.message || e).slice(0, 200) }, false);
    }
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "run") JF.run(msg);
    if (msg.type === "confirm" && !JF.confirming) { JF.confirming = true; confirmLoop(msg.jobId); }
  });
}
