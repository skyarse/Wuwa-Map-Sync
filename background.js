const P = globalThis.WuwaProgress;
const S = globalThis.WuwaSync;
const G = globalThis.WuwaDrive;
const SITE = ["https://www.wuwabuild.com/*", "https://wuwabuild.com/*"];
let queue = Promise.resolve();
let running = null;
let connecting = false;
let epoch = 0;

function serial(work) {
  const result = queue.then(work);
  queue = result.catch(() => {});
  return result;
}

async function load() {
  const stored = await browser.storage.local.get(["syncState", "backup", "pending"]);
  if (stored.syncState) {
    S.validate(S.payload(stored.syncState));
    return stored.syncState;
  }
  const initial = stored.pending?.found || stored.backup?.found || [];
  const state = S.create(crypto.randomUUID(), initial);
  state.pendingLegacy = Boolean(stored.pending);
  await save(state);
  await browser.storage.local.remove("pending");
  return state;
}

async function save(state, preserve = false) {
  const found = S.found(state);
  const old = await browser.storage.local.get("backup");
  const changed = !old.backup || !P.sameFound(old.backup.found, found);
  const update = { syncState: state };
  if (changed) {
    update.backup = { version: 1, found, savedAt: new Date().toISOString() };
    if (preserve && old.backup) update.beforeSync = old.backup;
  }
  await browser.storage.local.set(update);
}

function siteOrigin(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && ["www.wuwabuild.com", "wuwabuild.com"].includes(u.hostname)) return u.origin;
  } catch {}
  return null;
}

async function pageSync(msg, sender) {
  const origin = siteOrigin(sender.url);
  if (!origin || !sender.tab) throw new Error("Недопустимый источник отметок");
  const state = await load();
  const incoming = msg.found === null ? null : P.normalizeFound(msg.found);
  if (state.pendingLegacy) {
    state.pages[origin] = incoming;
    state.pendingLegacy = false;
  }
  state.pageTokens ||= {};
  const applied = msg.applied;
  if (applied && applied.device === state.device && typeof applied.token === "string" && applied.token.length <= 80 &&
      Array.isArray(applied.found) && state.pageTokens[origin] !== applied.token) {
    state.pages[origin] = P.normalizeFound(applied.found);
    state.pageTokens[origin] = applied.token;
  }
  S.observe(state, origin, incoming);
  await save(state);
  return { found: S.found(state), token: crypto.randomUUID(), device: state.device };
}

async function captureTabs() {
  const tabs = await browser.tabs.query({ url: SITE });
  await Promise.all(tabs.map(async (tab) => {
    let response;
    try { response = await browser.tabs.sendMessage(tab.id, { type: "capture" }); }
    catch { return; }
    if (response?.error) throw new Error(response.error);
  }));
}

async function notifyTabs() {
  const tabs = await browser.tabs.query({ url: SITE });
  await Promise.all(tabs.map((tab) => browser.tabs.sendMessage(tab.id, { type: "reconcile" }).catch(() => {})));
}

async function status(patch) {
  const old = await browser.storage.local.get("driveStatus");
  await browser.storage.local.set({ driveStatus: { ...old.driveStatus, ...patch } });
}

async function sync() {
  if (running) return running;
  if (connecting) return;
  const currentEpoch = epoch;
  const check = () => { if (epoch !== currentEpoch) throw new Error("Подключение изменилось; синхронизация остановлена"); };
  running = (async () => {
    const { driveAuth } = await browser.storage.local.get("driveAuth");
    if (!driveAuth) return;
    if (!await browser.permissions.contains(G.CONSENT)) {
      throw new Error("Firefox запретил передачу данных. Подключите Google Drive заново.");
    }
    await status({ connected: true, syncing: true, error: "" });
    const drive = new G.Drive(driveAuth, async (auth) => {
      check();
      await browser.storage.local.set({ driveAuth: auth });
    }, check);
    await captureTabs();
    check();
    const files = await drive.list();
    const remote = [];
    for (const file of files) remote.push(await drive.read(file.id));
    check();
    const snapshot = await serial(async () => {
      check();
      const state = await load();
      for (const data of remote) S.merge(state, data);
      await save(state, true);
      return S.payload(state);
    });
    check();
    const ownIndex = files.findIndex((file, i) => remote[i].device === snapshot.device &&
      file.appProperties?.device === snapshot.device);
    const own = ownIndex < 0 ? null : files[ownIndex];
    if (!own || JSON.stringify(remote[ownIndex]) !== JSON.stringify(snapshot)) {
      await drive.write(own?.id, snapshot);
    }
    check();
    await status({ connected: true, syncing: false, error: "", lastSync: new Date().toISOString() });
    await notifyTabs();
  })().catch(async (error) => {
    if (epoch === currentEpoch) await status({ syncing: false, error: error.message || "Ошибка синхронизации" });
    throw error;
  }).finally(() => { running = null; });
  return running;
}

async function connect() {
  if (connecting || running) throw new Error("Дождитесь завершения текущего подключения или синхронизации");
  if (!await browser.permissions.contains(G.CONSENT)) throw new Error("Разрешите Firefox передачу данных для синхронизации");
  connecting = true;
  const currentEpoch = ++epoch;
  try {
    const auth = await G.authorize();
    if (epoch !== currentEpoch) throw new Error("Подключение отменено");
    await browser.storage.local.set({ driveAuth: auth });
    await status({ connected: true, syncing: false, error: "", lastSync: null });
  } finally {
    connecting = false;
  }
  await sync();
  return { ok: true };
}

async function handle(msg, sender) {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "page-sync") return serial(() => pageSync(msg, sender));
  if (sender.tab && siteOrigin(sender.url)) return;
  if (!sender.url?.startsWith(browser.runtime.getURL(""))) return;
  if (msg.type === "drive-connect") return connect();
  if (msg.type === "drive-sync") { await sync(); return { ok: true }; }
  if (msg.type === "drive-disconnect") {
    ++epoch;
    await browser.storage.local.remove("driveAuth");
    await status({ connected: false, syncing: false, error: "", lastSync: null });
    return { ok: true };
  }
  if (msg.type === "progress-apply") {
    await captureTabs();
    const result = await serial(async () => {
      const state = await load();
      const incoming = P.normalizeFound(msg.found);
      if (msg.mode === "merge") S.edit(state, incoming.map((id) => [id, true]));
      else if (msg.mode === "replace") S.replace(state, incoming);
      else throw new Error("Неизвестный режим импорта");
      await save(state, true);
      return { found: S.found(state) };
    });
    await notifyTabs();
    return result;
  }
  if (msg.type === "progress-init") {
    await serial(load);
    await captureTabs();
    const { driveAuth } = await browser.storage.local.get("driveAuth");
    await status({ connected: Boolean(driveAuth), syncing: Boolean(running) });
    return { configured: Boolean(globalThis.WUWA_OAUTH.clientId) };
  }
}

browser.runtime.onMessage.addListener((msg, sender) => handle(msg, sender).catch((error) => ({ error: error.message || "Ошибка расширения" })));
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "wuwa-drive-sync") sync().catch(() => {});
});

async function start() {
  await serial(load);
  await browser.alarms.create("wuwa-drive-sync", { periodInMinutes: 1 });
  sync().catch(() => {});
}

browser.runtime.onStartup.addListener(() => start().catch(() => {}));
browser.runtime.onInstalled.addListener(() => start().catch(() => {}));
