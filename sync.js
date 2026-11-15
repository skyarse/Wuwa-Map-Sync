(function (root) {
  const P = root.WuwaProgress;
  const APP = "wuwa-map-progress";
  const MAX_RECORDS = 100000;
  const validDevice = (id) => typeof id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(id);
  const validId = (id) => typeof id === "string" && id.length <= 512 && id.trim() === id && id.includes("::");

  function create(device, found = []) {
    if (!validDevice(device)) throw new Error("Некорректный ID устройства");
    const records = {};
    for (const id of P.normalizeFound(found)) records[id] = [true, 0, device];
    return { version: 2, device, clock: 0, records, pages: {} };
  }

  function found(state) {
    return Object.keys(state.records).filter((id) => state.records[id][0]).sort();
  }

  function edit(state, changes) {
    const next = changes.filter(([id, present]) => (state.records[id]?.[0] || false) !== present);
    if (!next.length) return false;
    if (++state.clock >= 2 ** 48) throw new Error("Счётчик изменений исчерпан");
    for (const [id, present] of next) state.records[id] = [present, state.clock, state.device];
    return true;
  }

  function observe(state, origin, incoming) {
    if (incoming === null) {
      state.pages[origin] = null;
      return false;
    }
    const current = new Set(P.normalizeFound(incoming));
    const previous = state.pages[origin];
    const changes = [];
    if (Array.isArray(previous)) {
      const before = new Set(previous);
      for (const id of current) if (!before.has(id)) changes.push([id, true]);
      for (const id of before) if (!current.has(id)) changes.push([id, false]);
    } else {
      for (const id of current) {
        if (!Object.hasOwn(state.records, id)) state.records[id] = [true, 0, state.device];
      }
    }
    const changed = edit(state, changes);
    state.pages[origin] = [...current];
    return changed;
  }

  function replace(state, incoming) {
    const next = new Set(P.normalizeFound(incoming));
    const ids = new Set([...Object.keys(state.records), ...next]);
    return edit(state, [...ids].map((id) => [id, next.has(id)]));
  }

  function payload(state) {
    return {
      app: APP,
      version: 2,
      device: state.device,
      records: Object.entries(state.records).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    };
  }

  function validate(data) {
    if (!data || data.app !== APP || data.version !== 2 || !validDevice(data.device) ||
        !Array.isArray(data.records) || data.records.length > MAX_RECORDS) {
      throw new Error("Неизвестный формат синхронизации в Google Drive");
    }
    const seen = new Set();
    for (const row of data.records) {
      if (!Array.isArray(row) || row.length !== 2) throw new Error("Повреждена запись синхронизации");
      const [id, value] = row;
      if (!validId(id) || seen.has(id) || !Array.isArray(value) || value.length !== 3 ||
          typeof value[0] !== "boolean" || !Number.isSafeInteger(value[1]) ||
          value[1] < 0 || value[1] >= 2 ** 48 || !validDevice(value[2])) {
        throw new Error("Повреждена запись синхронизации");
      }
      seen.add(id);
    }
    return data;
  }

  function merge(state, data) {
    validate(data);
    let changed = false;
    for (const [id, next] of data.records) {
      const current = state.records[id];
      state.clock = Math.max(state.clock, next[1]);
      if (!current || next[1] > current[1] ||
          (next[1] === current[1] && next[2] > current[2]) ||
          (next[1] === current[1] && next[2] === current[2] && !next[0] && current[0])) {
        state.records[id] = [...next];
        changed = true;
      }
    }
    if (Object.keys(state.records).length > MAX_RECORDS) throw new Error("Слишком много отметок");
    return changed;
  }

  root.WuwaSync = { APP, create, found, edit, observe, replace, payload, validate, merge };
})(globalThis);
