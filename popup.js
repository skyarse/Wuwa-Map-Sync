const P = globalThis.WuwaProgress;
const SITE = ["https://www.wuwabuild.com/*", "https://wuwabuild.com/*"];

const els = {
  pageLine: document.querySelector("#page-line"),
  backupLine: document.querySelector("#backup-line"),
  regions: document.querySelector("#regions"),
  status: document.querySelector("#status"),
  exportBtn: document.querySelector("#export"),
  mergeBtn: document.querySelector("#merge"),
  replaceBtn: document.querySelector("#replace"),
  restoreBtn: document.querySelector("#restore"),
  file: document.querySelector("#file"),
};

let importMode = "merge";
let view = { page: null, backup: null, tab: null };

function setStatus(text, kind) {
  els.status.textContent = text || "";
  els.status.dataset.kind = kind || "";
}

function formatWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isSite(url) {
  return typeof url === "string" && /^https:\/\/(www\.)?wuwabuild\.com\//.test(url);
}

async function findTab() {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active && isSite(active.url)) return active;
  const tabs = await browser.tabs.query({ url: SITE });
  return tabs.find((tab) => isSite(tab.url)) || null;
}

async function readFromTab(tab) {
  if (!tab) return null;
  const res = await browser.tabs.sendMessage(tab.id, { type: "read" });
  if (res?.error) throw new Error(res.error);
  if (res?.version !== "1.1.1") throw new Error("Обновите вкладку карты после установки новой версии расширения");
  return res.found;
}

function renderRegions(found) {
  const rows = found && found.length ? P.summarize(found) : [];
  els.regions.replaceChildren();
  if (!rows.length) {
    els.regions.hidden = true;
    return;
  }
  els.regions.hidden = false;
  for (const row of rows) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = row.name;
    const count = document.createElement("span");
    count.textContent = String(row.count);
    li.append(name, count);
    els.regions.append(li);
  }
}

function render() {
  const { page, backup, tab } = view;
  if (!tab) {
    els.pageLine.textContent = "Сайт не открыт. Копия ниже останется в расширении.";
  } else if (page == null) {
    els.pageLine.textContent = "На сайте отметок ещё нет.";
  } else {
    els.pageLine.textContent = "На сайте: " + page.length + " " + marks(page.length);
  }

  if (!backup) {
    els.backupLine.textContent = "Копии в расширении пока нет. Откройте карту и отметьте точку.";
  } else {
    const when = formatWhen(backup.savedAt);
    els.backupLine.textContent =
      "Копия в расширении: " +
      backup.found.length +
      " " +
      marks(backup.found.length) +
      (when ? " · " + when : "");
  }

  const shown = page != null ? page : (backup && backup.found) || [];
  renderRegions(shown);
  els.exportBtn.disabled = shown.length === 0;
  els.restoreBtn.disabled = !backup || backup.found.length === 0;
}

function marks(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "отметка";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "отметки";
  return "отметок";
}

async function refresh() {
  const [tab, stored] = await Promise.all([
    findTab(),
    browser.storage.local.get("backup"),
  ]);
  let page = null;
  if (tab) {
    try {
      page = await readFromTab(tab);
    } catch (error) {
      setStatus(error.message || "Не удалось прочитать карту", "bad");
    }
  }
  view = { page, backup: stored.backup || null, tab };
  render();
}

function download(found) {
  const payload = P.exportPayload(found);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const day = payload.exportedAt.slice(0, 10);
  link.href = url;
  link.download = "wuwa-map-progress-" + day + ".json";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function applyFound(found, label, mode = "replace") {
  const result = await browser.runtime.sendMessage({ type: "progress-apply", found, mode });
  if (result?.error) throw new Error(result.error);
  setStatus(label + " Отметки появятся на открытой карте в течение пары секунд.", "ok");
  await refresh();
}

els.exportBtn.addEventListener("click", () => {
  const found = view.page != null ? view.page : view.backup && view.backup.found;
  if (!found || !found.length) return;
  download(found);
  setStatus("Файл сохранён.", "ok");
});

function pickFile(mode) {
  importMode = mode;
  els.file.value = "";
  els.file.click();
}

// Firefox closes the toolbar popup when the file dialog opens,
// so import runs from the same page opened in a normal tab.
const IN_TAB = new URLSearchParams(location.search).has("tab");

async function startImport(mode) {
  if (IN_TAB) {
    pickFile(mode);
    return;
  }
  await browser.tabs.create({ url: browser.runtime.getURL("popup.html?tab=1") });
  window.close();
}

els.mergeBtn.addEventListener("click", () => startImport("merge"));
els.replaceBtn.addEventListener("click", () => startImport("replace"));

els.file.addEventListener("change", async () => {
  const file = els.file.files && els.file.files[0];
  if (!file) return;
  let found;
  try {
    found = P.parseProgressFile(await file.text());
  } catch (error) {
    setStatus(error.message || "Не удалось прочитать файл", "bad");
    return;
  }
  if (importMode === "replace") {
    const ok = confirm(
      "Заменить отметки на сайте этим файлом (" + found.length + ")? Карта перезагрузится."
    );
    if (!ok) return;
    try {
      await applyFound(found, "Заменено: " + found.length + ".");
    } catch (error) {
      setStatus(error.message || "Не удалось записать", "bad");
    }
    return;
  }
  try {
    await applyFound(found, "Импортировано " + found.length + ".", "merge");
  } catch (error) {
    setStatus(error.message || "Не удалось записать", "bad");
  }
});

els.restoreBtn.addEventListener("click", async () => {
  const backup = view.backup;
  if (!backup || !backup.found.length) return;
  const ok = confirm(
    "Подставить копию из расширения (" +
      backup.found.length +
      ") вместо отметок на сайте? Карта перезагрузится."
  );
  if (!ok) return;
  try {
    await applyFound(backup.found, "Копия возвращена на сайт.");
  } catch (error) {
    setStatus(error.message || "Не удалось вернуть копию", "bad");
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.backup) return;
  view.backup = changes.backup.newValue || null;
  render();
});

initialize().catch((error) => {
  setStatus(error.message || "Ошибка расширения", "bad");
});

const driveLine = document.querySelector("#drive-line");
const connectBtn = document.querySelector("#drive-connect");
const syncBtn = document.querySelector("#drive-sync");
const disconnectBtn = document.querySelector("#drive-disconnect");
const rescueBtn = document.querySelector("#rescue");
let driveBusy = false;

async function renderDrive() {
  const { driveStatus: status = {}, beforeSync } = await browser.storage.local.get(["driveStatus", "beforeSync"]);
  driveLine.textContent = status.error || (status.syncing ? "Синхронизация…" : status.connected ?
    "Подключено" + (status.lastSync ? " · " + formatWhen(status.lastSync) : " · ещё не синхронизировано") : "Не подключён");
  driveLine.dataset.kind = status.error ? "bad" : "";
  connectBtn.textContent = status.connected ? "Войти в Google повторно" : "Подключить Google Drive";
  connectBtn.disabled = driveBusy || status.syncing;
  syncBtn.disabled = driveBusy || !status.connected || status.syncing;
  disconnectBtn.disabled = !status.connected && !driveBusy;
  rescueBtn.hidden = !beforeSync;
}

async function driveAction(type) {
  driveBusy = true;
  await renderDrive();
  try {
    const result = await browser.runtime.sendMessage({ type });
    if (result?.error) throw new Error(result.error);
    setStatus(type === "drive-disconnect" ? "Синхронизация отключена. Копии сохранены." : "Готово.", "ok");
    await refresh();
  } catch (error) {
    setStatus(error.message || "Ошибка Google Drive", "bad");
  } finally {
    driveBusy = false;
    await renderDrive();
  }
}

connectBtn.addEventListener("click", async () => {
  if (!IN_TAB) {
    await browser.tabs.create({ url: browser.runtime.getURL("popup.html?tab=1") });
    window.close();
    return;
  }
  if (!globalThis.WUWA_OAUTH.clientId) {
    setStatus("В этой сборке ещё не настроен вход Google. Нужен OAuth-клиент разработчика; инструкция в README.md.", "bad");
    return;
  }
  try {
    const permission = await browser.permissions.request(globalThis.WuwaDrive.CONSENT);
    if (!permission) { setStatus("Без разрешения Firefox синхронизация недоступна.", "bad"); return; }
    await driveAction("drive-connect");
  } catch (error) { setStatus(error.message || "Не удалось подключить Google Drive", "bad"); }
});
syncBtn.addEventListener("click", () => driveAction("drive-sync"));
disconnectBtn.addEventListener("click", () => driveAction("drive-disconnect"));
rescueBtn.addEventListener("click", async () => {
  const { beforeSync } = await browser.storage.local.get("beforeSync");
  if (beforeSync) download(beforeSync.found);
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.driveStatus || changes.beforeSync)) renderDrive().catch(() => {});
});

async function initialize() {
  const result = await browser.runtime.sendMessage({ type: "progress-init" });
  if (result?.error) throw new Error(result.error);
  await refresh();
  await renderDrive();
}
