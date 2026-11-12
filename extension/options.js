const $ = (id) => document.getElementById(id);

async function render() {
  const s = await chrome.storage.local.get(["token", "paused", "status", "active"]);
  $("token").placeholder = s.token ? "Saved (paste to replace)" : "Paste token";
  $("pause").textContent = s.paused ? "Resume" : "Pause";
  $("pause").classList.toggle("on", !!s.paused);
  $("status").textContent = [s.paused ? "Paused." : "", s.active ? (s.active.kind === "collect" ? "" : `Working on job #${s.active.jobId} (${s.active.site}, ${s.active.mode === "submit" ? "submitting" : "filling"})`) : "", s.status || ""].filter(Boolean).join("\n");
}

$("save").onclick = async () => {
  const t = $("token").value.trim();
  if (t) await chrome.storage.local.set({ token: t });
  $("token").value = "";
  render();
};
$("pause").onclick = async () => {
  const { paused } = await chrome.storage.local.get("paused");
  await chrome.storage.local.set({ paused: !paused });
  render();
};
$("now").onclick = async () => { await chrome.runtime.sendMessage({ type: "tickNow" }); setTimeout(render, 1500); };
chrome.storage.onChanged.addListener(render);
render();
