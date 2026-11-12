// Job Finder Apply: background service worker.
// It asks the local app for the next job, opens it in one background tab, injects the site adapter, relays the
// adapter's API calls (the token never leaves this worker), and reports the outcome. All decisions live in the app.

const API = "http://localhost:3100";
const MAX_NEEDS_YOU_TABS = 8;
const JOB_TIMEOUT_MS = 6 * 60_000;
const ADAPTERS = { greenhouse: "greenhouse.js", lever: "lever.js", ashby: "ashby.js", workable: "workable.js", linkedin: "linkedin.js" };

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);
const rand = ([a, b]) => a + Math.random() * (b - a);

/**
 * Chrome stops an idle service worker after 30 seconds, and a pending setTimeout doesn't count as activity.
 * Long waits are cut into short slices with an extension API call between them, which resets the idle timer.
 */
async function wait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, Math.min(10_000, end - Date.now())));
    await chrome.storage.local.get("token");
  }
}

let ticking = false;

async function api(path, { method = "GET", body } = {}) {
  const { token } = await get("token");
  if (!token) throw new Error("No token: paste it in the extension options");
  const res = await fetch(API + path, {
    method,
    headers: { "x-jobfinder-token": token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error("Token rejected: copy it again from Sites & caps");
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Some ATSs put the form on its own page; open that page directly so no in-page navigation kills the script. */
function formUrl(url, site) {
  const u = url.replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (site === "lever" && !/\/apply$/.test(u)) return u + "/apply";
  if (site === "ashby" && !/\/application$/.test(u)) return u + "/application";
  if (site === "workable" && /\/j\/[^/]+$/.test(u)) return u + "/apply/";
  return url;
}

async function openNeedsYouTabs() {
  const { needsYouTabs = [] } = await get("needsYouTabs");
  const open = [];
  for (const id of needsYouTabs) { try { await chrome.tabs.get(id); open.push(id); } catch { /* closed by Sherif */ } }
  await set({ needsYouTabs: open });
  return open;
}

async function tick() {
  if (ticking) return; // "Check now" and the alarm must not both lease a job
  ticking = true;
  try { await tickOnce(); } finally { ticking = false; }
}

async function tickOnce() {
  const s = await get(["paused", "active", "nextAt", "token"]);
  if (s.paused || !s.token) return;
  if (s.active) {
    if (s.active.kind === "collect") {
      // A collection pass whose worker was stopped mid-way: clean up its tab and carry on.
      if (Date.now() - s.active.startedAt > 15 * 60_000) {
        if (s.active.tabId != null) { await releaseFocus(s.active.tabId); try { await chrome.tabs.remove(s.active.tabId); } catch { /* gone */ } }
        await set({ active: null });
      }
      return;
    }
    if (Date.now() - s.active.startedAt > JOB_TIMEOUT_MS) await finish(s.active.jobId, { outcome: "failed", reason: "Timed out in the browser" }, false);
    return;
  }
  if (s.nextAt && Date.now() < s.nextAt) return;
  const waiting = await openNeedsYouTabs();
  chrome.action.setBadgeText({ text: waiting.length ? String(waiting.length) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#F5B544" });
  if (waiting.length >= MAX_NEEDS_YOU_TABS) { await set({ status: `Waiting: ${waiting.length} tabs need you. Finish or close some.` }); return; }

  // LinkedIn collection runs between applications, when it's due.
  try {
    const c = await (await api("/api/ext/collect")).json();
    if (c.due) { await collectLinkedIn(c.searches, c.perSearch); return; }
  } catch (e) { await set({ status: String(e.message || e) }); return; }

  let next;
  try { next = await (await api("/api/ext/next")).json(); }
  catch (e) { await set({ status: String(e.message || e) }); return; }
  if (next.idle) { await set({ status: `Idle: ${next.idle}` }); return; }
  if (!ADAPTERS[next.site]) { await set({ status: `No adapter for ${next.site}` }); return; }

  // Record the job before the page loads, so the first "complete" event always finds it.
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  await set({
    active: { jobId: next.jobId, site: next.site, mode: next.mode, tabId: tab.id, pacing: next.pacing, phase: "fill", startedAt: Date.now() },
    status: `Working on job #${next.jobId}`,
  });
  await emulateFocus(tab.id);
  await chrome.tabs.update(tab.id, { url: formUrl(next.url, next.site) });
}

/**
 * Background tabs never get focus, so custom dropdowns (React selects) ignore scripted clicks: they only open
 * once the input has received a focus event. Focus emulation (the same switch Puppeteer uses) makes the page
 * behave as if focused. Chrome shows a "started debugging this browser" bar while it's attached; it's
 * detached as soon as the job finishes.
 */
async function emulateFocus(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch { /* already attached, or DevTools open on the tab: carry on without it */ }
}

async function releaseFocus(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch { /* not attached */ }
}

async function inject(tabId, site) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content/common.js", `content/${ADAPTERS[site]}`] });
}

// Every time the job's tab finishes loading, (re)inject and tell the script what phase it's in:
// "fill" on the first load, "confirm" after a submit navigated to a new page.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  const { active } = await get("active");
  if (!active || active.tabId !== tabId || active.kind === "collect") return;
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t || t.url === "about:blank") return;
  if (active.phase === "confirm" || !active.injected) {
    try {
      await inject(tabId, active.site);
      await set({ active: { ...active, injected: true } });
      chrome.tabs.sendMessage(tabId, { type: active.phase === "confirm" ? "confirm" : "run", jobId: active.jobId, mode: active.mode, pacing: active.pacing, site: active.site });
    } catch (e) {
      await finish(active.jobId, { outcome: "failed", reason: `Could not run on the page: ${e.message || e}` }, false);
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { active } = await get("active");
  if (active && active.tabId === tabId) await finish(active.jobId, { outcome: "failed", reason: "Tab was closed" }, false, true);
});

function waitComplete(tabId, ms = 30_000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(false); }, ms);
    const l = (id, info) => { if (id === tabId && info.status === "complete") { clearTimeout(t); chrome.tabs.onUpdated.removeListener(l); resolve(true); } };
    chrome.tabs.onUpdated.addListener(l);
  });
}

/** One collection pass: each search in the same background tab, cards read at human pace, saved to the app. */
async function collectLinkedIn(searches, perSearch) {
  await set({ active: { kind: "collect", startedAt: Date.now(), tabId: null }, status: "Collecting LinkedIn jobs" });
  let tabId = null, total = 0;
  try {
    for (const [i, url] of searches.entries()) {
      if (tabId == null) {
        tabId = (await chrome.tabs.create({ url, active: false })).id;
        await set({ active: { kind: "collect", startedAt: Date.now(), tabId } });
      } else await chrome.tabs.update(tabId, { url });
      await waitComplete(tabId);
      await emulateFocus(tabId);
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content/common.js", "content/linkedin-collect.js"] });
      const r = await chrome.tabs.sendMessage(tabId, { type: "collect", limit: perSearch });
      if (r?.blocked) {
        await api("/api/ext/listings", { method: "POST", body: { jobs: [], done: true, blocked: r.blocked } });
        await set({ status: `LinkedIn showed a ${r.blocked === "login_wall" ? "login wall" : "security check"}: LinkedIn paused` });
        break;
      }
      const last = i === searches.length - 1;
      await api("/api/ext/listings", { method: "POST", body: { jobs: r?.jobs || [], done: last } });
      total += (r?.jobs || []).length;
      if (!last) await wait(20_000 + Math.random() * 40_000);
    }
  } catch (e) {
    await set({ status: `Collection error: ${e.message || e}` });
  } finally {
    // Mark the pass done even after an error, so a broken page isn't retried every minute.
    try { await api("/api/ext/listings", { method: "POST", body: { jobs: [], done: true } }); } catch { /* app down */ }
    if (tabId != null) { await releaseFocus(tabId); try { await chrome.tabs.remove(tabId); } catch { /* gone */ } }
    await set({ active: null, status: `Collected ${total} LinkedIn jobs` });
  }
}

/** Reports the outcome, closes the tab unless Sherif needs it, and schedules the next job at human pace. */
async function finish(jobId, report, keepOpen, tabGone = false) {
  const { active, needsYouTabs = [] } = await get(["active", "needsYouTabs"]);
  if (!active || active.jobId !== jobId) return; // already finished (e.g. confirmed by both scripts)
  await set({ active: null });
  // After the submit click the application may already be sent: never let it go back to the queue.
  if (active.phase === "confirm" && report.outcome === "failed") {
    report = { outcome: "needs_you", reason: `Submitted? check the tab (${report.reason || "no confirmation"})` };
    keepOpen = true;
  }
  await releaseFocus(active.tabId);
  try { await api("/api/ext/report", { method: "POST", body: { jobId, ...report } }); }
  catch (e) { await set({ status: `Report failed: ${e.message || e}` }); }
  if (keepOpen && !tabGone) await set({ needsYouTabs: [...needsYouTabs, active.tabId] });
  else if (!tabGone) { try { await chrome.tabs.remove(active.tabId); } catch { /* gone */ } }
  const between = active.pacing?.betweenAppsSec ?? [90, 240];
  await set({ nextAt: Date.now() + rand(between) * 1000, status: `Job #${jobId}: ${report.outcome}${report.reason ? ` (${report.reason})` : ""}` });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const { active } = await get("active");
    switch (msg.type) {
      case "sleep": return setTimeout(() => reply({ ok: true }), Math.min(Math.max(0, msg.ms || 0), 120_000));
      case "tickNow": await set({ nextAt: 0 }); await tick(); return reply({ ok: true });
      case "plan": return reply(await (await api("/api/ext/plan", { method: "POST", body: { jobId: msg.jobId, fields: msg.fields } })).json());
      case "getFile": {
        const res = await api(`/api/ext/file/${msg.jobId}/${msg.kind}`);
        const name = (res.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1] || `${msg.kind}.pdf`;
        return reply({ name, base64: toBase64(await res.arrayBuffer()) });
      }
      case "submitting": // the page may navigate away; re-inject on the next load to look for the confirmation
        if (active && active.jobId === msg.jobId) {
          await set({ active: { ...active, phase: "confirm" } });
          await api("/api/ext/report", { method: "POST", body: { jobId: msg.jobId, outcome: "submitting" } });
        }
        return reply({ ok: true });
      case "done": await finish(msg.jobId, msg.report, !!msg.keepOpen); return reply({ ok: true });
      default: return reply({ error: "unknown message" });
    }
  })().catch((e) => reply({ error: String(e.message || e) }));
  return true; // async reply
});

chrome.alarms.create("tick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "tick") tick(); });
chrome.runtime.onStartup.addListener(() => set({ active: null }));
