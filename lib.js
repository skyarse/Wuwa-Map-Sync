// Shared by the content script, the popup, and node tests.
(function (root) {
  const KEY = "wuwa-map-found";

  const MAP_NAMES = {
    huanglong: "Huanglong",
    "tethys-deep": "Tethys' Deep",
    rinascita: "Rinascita",
    "riccioli-islands": "Riccioli Islands",
    "vault-underground": "Vault Underground",
    "beohr-waters": "Beohr Waters",
    avinoleum: "Avinoleum",
    septimont: "Septimont",
    "fabricatorium-of-the-deep": "Fabricatorium of the Deep",
    "sanguis-plateaus": "Sanguis Plateaus",
    "lahai-roi": "Lahai-Roi",
    "roya-frostlands": "Roya Frostlands",
    "dimmr-plains": "Dimmr Plains",
    mengzhou: "Mengzhou",
    "simulacrum-nexus": "Simulacrum Nexus",
  };

  // Site stores a JSON array of "mapId::markerId". Drop anything else.
  function normalizeFound(value) {
    if (!Array.isArray(value)) throw new Error("Ожидался список отметок");
    if (value.length > 100000) throw new Error("Слишком много отметок");
    const out = [];
    const seen = new Set();
    for (const item of value) {
      if (typeof item !== "string") continue;
      const id = item.trim();
      if (id.length > 512) throw new Error("Слишком длинный ID отметки");
      if (!id || seen.has(id) || !id.includes("::")) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  function parseProgressFile(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Файл не JSON");
    }
    let list;
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.found)) list = data.found;
    else if (data && typeof data[KEY] === "string") {
      let inner;
      try {
        inner = JSON.parse(data[KEY]);
      } catch {
        throw new Error("Неизвестный формат");
      }
      if (!Array.isArray(inner)) throw new Error("Неизвестный формат");
      list = inner;
    } else {
      throw new Error("Неизвестный формат");
    }
    const found = normalizeFound(list);
    if (list.length > 0 && found.length === 0) {
      throw new Error("В файле нет отметок карты");
    }
    return found;
  }

  function mergeFound(current, incoming) {
    return normalizeFound([].concat(current || [], incoming || []));
  }

  function sameFound(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    const seen = new Set(a);
    return b.every((id) => seen.has(id));
  }

  function summarize(found) {
    const counts = new Map();
    for (const id of found) {
      const mapId = id.split("::")[0] || "unknown";
      counts.set(mapId, (counts.get(mapId) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ id, name: MAP_NAMES[id] || id, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function exportPayload(found, exportedAt) {
    return {
      version: 1,
      site: "wuwabuild.com",
      key: KEY,
      exportedAt: exportedAt || new Date().toISOString(),
      found,
    };
  }

  root.WuwaProgress = {
    KEY,
    MAP_NAMES,
    normalizeFound,
    parseProgressFile,
    mergeFound,
    sameFound,
    summarize,
    exportPayload,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
