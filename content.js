const { KEY, normalizeFound, sameFound } = globalThis.WuwaProgress;
let running = null;
let rerun = false;
const APPLIED_KEY = "wuwa-map-progress-applied";

function applied() {
  try { return JSON.parse(localStorage.getItem(APPLIED_KEY)); }
  catch { return null; }
}

function readRaw() {
  const raw = localStorage.getItem(KEY);
  if (raw == null) return null;
  return normalizeFound(JSON.parse(raw));
}

async function syncFromPage() {
  if (running) { rerun = true; return running; }
  running = (async () => {
    const before = readRaw();
    const response = await browser.runtime.sendMessage({ type: "page-sync", found: before, applied: applied() });
    if (response?.error) throw new Error(response.error);
    if (!Array.isArray(response?.found)) return;
    const current = readRaw();
    if (before === null ? current !== null : current === null || !sameFound(before, current)) {
      rerun = true;
      return;
    }
    if (sameFound(current || [], response.found)) return;
    localStorage.setItem(KEY, JSON.stringify(response.found));
    localStorage.setItem(APPLIED_KEY, JSON.stringify({ token: response.token, device: response.device, found: response.found }));
    browser.runtime.sendMessage({ type: "page-sync", found: response.found, applied: applied() }).catch(() => {});
    if (location.pathname === "/map" || location.pathname.startsWith("/map/")) location.reload();
  })().finally(() => {
    running = null;
    if (rerun) {
      rerun = false;
      syncFromPage().catch(() => {});
    }
  });
  return running;
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "read") {
    try { return Promise.resolve({ found: readRaw(), applied: applied(), version: "1.1.1" }); }
    catch (error) { return Promise.resolve({ error: error.message }); }
  }
  if (msg?.type === "capture") {
    return syncFromPage().then(() => ({ ok: true })).catch((error) => ({ error: error.message }));
  }
  if (msg?.type === "reconcile") {
    syncFromPage().catch(() => {});
    return Promise.resolve({ ok: true });
  }
});

syncFromPage().catch(() => {});
setInterval(() => syncFromPage().catch(() => {}), 2000);
window.addEventListener("storage", (event) => {
  if (event.key === KEY || event.key === null) syncFromPage().catch(() => {});
});
