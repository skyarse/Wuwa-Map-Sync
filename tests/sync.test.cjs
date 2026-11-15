const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto").webcrypto;
const ROOT = path.resolve(__dirname, "..");
const clone = (x) => structuredClone(x);
const plain = (x) => JSON.parse(JSON.stringify(x));
const source = (name) => fs.readFileSync(path.join(ROOT, name === "oauth-config.js" ? "oauth-config.example.js" : name), "utf8");
const run = (ctx, name) => vm.runInContext(source(name), ctx, { filename: name });
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });

function core() {
  const ctx = vm.createContext({});
  run(ctx, "lib.js");
  run(ctx, "sync.js");
  return ctx.WuwaSync;
}

function cloud() {
  return {
    files: new Map(), calls: [], offline: false, failWrite: false, dropCreateReply: false,
    async fetch(url, options = {}) {
      this.calls.push({ url, method: options.method || "GET" });
      if (this.offline) throw new Error("offline");
      const u = new URL(url);
      if (u.hostname === "oauth2.googleapis.com") {
        return Response.json({ access_token: "refreshed", expires_in: 3600 });
      }
      if (u.pathname === "/drive/v3/files") {
        return Response.json({ files: [...this.files].map(([id, f]) => ({ id, name: f.name, appProperties: f.appProperties })) });
      }
      const id = u.pathname.split("/").at(-1);
      if (u.pathname.startsWith("/drive/v3/files/")) {
        if (!this.files.has(id)) return new Response("", { status: 404 });
        return new Response(JSON.stringify(this.files.get(id).payload));
      }
      if (this.failWrite) return new Response("", { status: 503 });
      if (options.method === "PATCH") {
        if (!this.files.has(id)) return new Response("", { status: 404 });
        this.files.get(id).payload = JSON.parse(options.body);
        return Response.json({ id });
      }
      if (options.method === "POST") {
        const blocks = options.body.split("\r\n\r\n");
        const meta = JSON.parse(blocks[1].split("\r\n--")[0]);
        const payload = JSON.parse(blocks[2].split("\r\n--")[0]);
        const created = "file-" + (this.files.size + 1);
        this.files.set(created, { ...meta, payload });
        if (this.dropCreateReply) { this.dropCreateReply = false; throw new Error("lost response"); }
        return Response.json({ id: created });
      }
      throw new Error("Unexpected URL " + url);
    },
  };
}

function device(remote, initial = {}) {
  const data = clone(initial);
  const listeners = event();
  const pages = [];
  const onInstalled = event();
  const storage = {
    failNext: false,
    async get(keys) {
      const result = {};
      for (const key of typeof keys === "string" ? [keys] : keys) {
        if (Object.hasOwn(data, key)) result[key] = clone(data[key]);
      }
      return result;
    },
    async set(values) {
      if (this.failNext) { this.failNext = false; throw new Error("disk full"); }
      Object.assign(data, clone(values));
    },
    async remove(keys) { for (const key of typeof keys === "string" ? [keys] : keys) delete data[key]; },
  };
  const browser = {
    storage: { local: storage },
    permissions: { contains: async () => true },
    runtime: { getURL: (p) => "moz-extension://test/" + p, onMessage: listeners,
      onInstalled, onStartup: event() },
    alarms: { create: async () => {}, onAlarm: event() },
    tabs: {
      query: async () => pages.map((p, id) => ({ id, url: p.url })),
      sendMessage: async (id, message) => {
        for (const fn of pages[id].listeners.listeners) {
          const result = fn(clone(message));
          if (result !== undefined) return result;
        }
      },
    },
  };
  const ctx = vm.createContext({ browser, crypto, structuredClone, TextEncoder, URL, URLSearchParams,
    Uint8Array, btoa, AbortSignal, fetch: remote.fetch.bind(remote) });
  for (const name of ["lib.js", "sync.js", "oauth-config.js", "google-drive.js", "background.js"]) run(ctx, name);
  ctx.WUWA_OAUTH = { clientId: "123-test.apps.googleusercontent.com", clientSecret: "desktop-public-config" };
  const send = async (message, sender = { url: "moz-extension://test/popup.html" }) => {
    return plain(await listeners.listeners[0](clone(message), sender));
  };
  async function ok(message) {
    const result = await send(message);
    assert.equal(result?.error, undefined);
    return result;
  }
  function page(found, options = {}) {
    const id = pages.length;
    const values = options.values || new Map();
    if (found !== null) values.set("wuwa-map-found", JSON.stringify(found));
    const p = { url: "https://www.wuwabuild.com/map", listeners: event(), values, reloads: 0 };
    pages.push(p);
    const localStorage = {
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => values.set(k, v),
    };
    const cbrowser = { runtime: { onMessage: p.listeners, sendMessage: async (message) => {
      const response = await send(message, { url: p.url, tab: { id } });
      if (message.type === "page-sync" && p.beforeResponse) await p.beforeResponse(response);
      return response;
    } } };
    const cctx = vm.createContext({ browser: cbrowser, localStorage,
      setInterval: (fn) => { p.tick = fn; }, window: { addEventListener() {} },
      location: { pathname: "/map", reload: () => { p.reloads++; } } });
    run(cctx, "lib.js");
    run(cctx, "content.js");
    p.capture = () => browser.tabs.sendMessage(id, { type: "capture" });
    p.found = () => JSON.parse(values.get("wuwa-map-found") ?? "null");
    p.edit = (next) => values.set("wuwa-map-found", JSON.stringify(next));
    return p;
  }
  return { data, ctx, storage, send, ok, page,
    async enable() {
      data.driveAuth = { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3600000 };
      await ok({ type: "drive-sync" });
    },
    async sync() { return ok({ type: "drive-sync" }); },
  };
}

test("offline additions on separate devices converge", () => {
  const S = core();
  const a = S.create("a");
  const b = S.create("b");
  S.edit(a, [["map::1", true]]);
  S.edit(b, [["map::2", true]]);
  S.merge(a, S.payload(b));
  S.merge(b, S.payload(a));
  assert.deepEqual(plain(S.found(a)), ["map::1", "map::2"]);
  assert.deepEqual(plain(S.found(a)), plain(S.found(b)));
});

test("deletions survive stale backup and old device snapshots", () => {
  const S = core();
  const a = S.create("a", ["map::1"]);
  const stale = S.payload(a);
  S.replace(a, []);
  S.merge(a, stale);
  S.merge(a, S.payload(S.create("z", ["map::1"])));
  assert.deepEqual(plain(S.found(a)), []);
});

test("concurrent changes to the same marker resolve deterministically", () => {
  const S = core();
  const a = S.create("a", ["map::1"]);
  const b = S.create("b", ["map::1"]);
  S.replace(a, []);
  S.replace(b, []);
  S.replace(b, ["map::1"]);
  const pa = S.payload(a), pb = S.payload(b);
  S.merge(a, pb);
  S.merge(b, pa);
  assert.deepEqual(plain(S.found(a)), plain(S.found(b)));
  assert.deepEqual(plain(S.found(a)), ["map::1"]);
});

test("fresh change after receiving a deletion wins over the deletion", () => {
  const S = core();
  const a = S.create("a", ["map::1"]);
  const b = S.create("b");
  S.replace(a, []);
  S.merge(b, S.payload(a));
  S.replace(b, ["map::1"]);
  S.merge(a, S.payload(b));
  assert.deepEqual(plain(S.found(a)), ["map::1"]);
});

test("missing site data and first observation do not erase cloud state", () => {
  const S = core();
  const state = S.create("a", ["map::1"]);
  S.observe(state, "origin", null);
  S.observe(state, "origin", []);
  assert.deepEqual(plain(S.found(state)), ["map::1"]);
  S.observe(state, "origin", ["map::1"]);
  S.observe(state, "origin", []);
  assert.deepEqual(plain(S.found(state)), []);
});

test("invalid cloud payloads are rejected before mutation", () => {
  const S = core();
  const state = S.create("a", ["map::1"]);
  const before = JSON.stringify(state);
  for (const record of [["x", [true, 1, "a"]], ["map::1", [true, -1, "a"]],
    ["map::1", ["false", 1, "a"]], ["map::1", [false, 2 ** 50, "a"]]]) {
    assert.throws(() => S.merge(state, { app: S.APP, version: 2, device: "b", records: [record] }));
    assert.equal(JSON.stringify(state), before);
  }
});

test("random merge orders and duplicate deliveries converge", () => {
  const S = core();
  const states = ["a", "b", "c"].map((id) => S.create(id));
  let seed = 19;
  const rand = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 300; i++) {
    const target = states[rand(3)];
    if (rand(3)) S.edit(target, [["map::" + rand(20), Boolean(rand(2))]]);
    else S.merge(target, S.payload(states[rand(3)]));
  }
  const all = states.map((s) => S.payload(s));
  for (let i = 0; i < states.length; i++) for (const snapshot of [...all.slice(i), ...all.slice(0, i), ...all]) S.merge(states[i], snapshot);
  assert.deepEqual(plain(states[0].records), plain(states[1].records));
  assert.deepEqual(plain(states[0].records), plain(states[2].records));
});

test("legacy backup and pending replacement migrate without losing pending intent", async () => {
  const d = device(cloud(), { backup: { found: ["map::old"] }, pending: { found: ["map::new"] } });
  const p = d.page(["map::old"]);
  await p.capture();
  assert.deepEqual(p.found(), ["map::new"]);
  assert.deepEqual(d.data.backup.found, ["map::new"]);
  assert.equal(d.data.pending, undefined);
});

test("two devices sync additions, removals, offline changes and imported replacements", async () => {
  const remote = cloud(), a = device(remote), b = device(remote);
  const pa = a.page(["map::1"]), pb = b.page([]);
  await pa.capture(); await pb.capture();
  await a.enable(); await b.enable(); await pb.capture();
  assert.deepEqual(pb.found(), ["map::1"]);
  pa.edit(["map::1", "map::2"]);
  pb.edit([]);
  await pa.capture(); await pb.capture();
  await b.sync(); await a.sync(); await b.sync();
  await pa.capture(); await pb.capture();
  assert.deepEqual(pa.found(), ["map::2"]);
  assert.deepEqual(pb.found(), ["map::2"]);
  remote.offline = true;
  pa.edit(["map::2", "map::offline"]);
  await pa.capture();
  const failed = await a.send({ type: "drive-sync" });
  assert.match(failed.error, /Нет связи/);
  assert.deepEqual(a.data.backup.found, ["map::2", "map::offline"]);
  remote.offline = false;
  await a.sync(); await b.sync(); await pb.capture();
  assert.deepEqual(pb.found(), ["map::2", "map::offline"]);
  await a.ok({ type: "progress-apply", mode: "replace", found: ["map::imported"] });
  await a.sync(); await b.sync(); await pb.capture();
  assert.deepEqual(pb.found(), ["map::imported"]);
  assert.ok(a.data.beforeSync);
});

test("failed uploads keep local changes and retry without user intervention", async () => {
  const remote = cloud(), d = device(remote), p = d.page(["map::1"]);
  await p.capture(); await d.enable();
  p.edit(["map::2"]); await p.capture();
  remote.failWrite = true;
  assert.match((await d.send({ type: "drive-sync" })).error, /503/);
  assert.deepEqual(d.data.backup.found, ["map::2"]);
  remote.failWrite = false;
  await d.sync();
  const other = device(remote), op = other.page([]);
  await op.capture(); await other.enable(); await op.capture();
  assert.deepEqual(op.found(), ["map::2"]);
});

test("lost create response does not produce duplicate device files on retry", async () => {
  const remote = cloud(), d = device(remote), p = d.page(["map::1"]);
  await p.capture();
  remote.dropCreateReply = true;
  d.data.driveAuth = { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600000 };
  assert.ok((await d.send({ type: "drive-sync" })).error);
  assert.equal(remote.files.size, 1);
  await d.sync();
  assert.equal(remote.files.size, 1);
});

test("corrupt remote JSON stops publication and preserves local backup", async () => {
  const remote = cloud(), d = device(remote), p = d.page(["map::1"]);
  await p.capture(); await d.enable();
  remote.files.set("bad", { name: "wuwa-map-progress-v2-bad.json", payload: { version: 99 } });
  const writesBefore = remote.calls.filter((c) => c.method !== "GET").length;
  const result = await d.send({ type: "drive-sync" });
  assert.match(result.error, /Повреждён/);
  assert.deepEqual(d.data.backup.found, ["map::1"]);
  assert.equal(remote.calls.filter((c) => c.method !== "GET").length, writesBefore);
});

test("disconnect stops all later cloud calls without deleting progress", async () => {
  const remote = cloud(), d = device(remote), p = d.page(["map::1"]);
  await p.capture(); await d.enable();
  await d.ok({ type: "drive-disconnect" });
  const before = remote.calls.length;
  await d.sync();
  assert.equal(remote.calls.length, before);
  assert.equal(d.data.driveAuth, undefined);
  assert.deepEqual(d.data.backup.found, ["map::1"]);
  assert.equal(remote.files.size, 1);
});

test("expired access token refreshes without opening login", async () => {
  const remote = cloud(), d = device(remote);
  await d.ok({ type: "progress-init" });
  d.data.driveAuth = { accessToken: "old", refreshToken: "keep", expiresAt: 0 };
  await d.sync();
  assert.equal(d.data.driveAuth.accessToken, "refreshed");
  assert.equal(d.data.driveAuth.refreshToken, "keep");
});

test("storage failure does not suppress retry for the same site changes", async () => {
  const d = device(cloud()), p = d.page(["map::1"]);
  await p.capture();
  p.edit(["map::1", "map::2"]);
  d.storage.failNext = true;
  const result = await p.capture();
  assert.ok(result.error);
  await p.capture();
  assert.deepEqual(d.data.backup.found, ["map::1", "map::2"]);
});

test("cloud serialization contains only marker records, never auth or page metadata", async () => {
  const remote = cloud(), d = device(remote), p = d.page(["map::1"]);
  await p.capture(); await d.enable();
  const payload = [...remote.files.values()][0].payload;
  assert.deepEqual(Object.keys(payload).sort(), ["app", "device", "records", "version"]);
  assert.equal(JSON.stringify(payload).includes("accessToken"), false);
});

test("legacy JSON export and import formats are still supported", () => {
  const ctx = vm.createContext({}); run(ctx, "lib.js");
  for (const text of [JSON.stringify(["map::1"]), JSON.stringify({ found: ["map::1"] }),
    JSON.stringify({ "wuwa-map-found": '["map::1"]' }), JSON.stringify(ctx.WuwaProgress.exportPayload(["map::1"]))]) {
    assert.deepEqual(plain(ctx.WuwaProgress.parseProgressFile(text)), ["map::1"]);
  }
});

test("same-counter opposite edits converge using a stable device tie break", () => {
  const S = core();
  const a = S.create("a", ["map::1"]), b = S.create("b");
  S.replace(a, []);
  S.replace(b, ["map::1"]);
  assert.equal(a.clock, b.clock);
  const pa = S.payload(a), pb = S.payload(b);
  S.merge(a, pb); S.merge(b, pa);
  assert.deepEqual(plain(a.records), plain(b.records));
  assert.deepEqual(plain(S.found(a)), ["map::1"]);
});

test("user edits while a page reply is pending are preserved", async () => {
  const d = device(cloud()), p = d.page(["map::1"]);
  await p.capture();
  let fired = false;
  p.beforeResponse = async () => {
    if (!fired) { fired = true; p.edit(["map::1", "map::new"]); }
  };
  await p.capture(); await p.capture();
  assert.deepEqual(p.found(), ["map::1", "map::new"]);
  assert.deepEqual(d.data.backup.found, ["map::1", "map::new"]);
});

test("applying an old cloud reply is not mistaken for a fresh user edit", async () => {
  const d = device(cloud()), p = d.page(["map::1"]);
  await p.capture();
  await vm.runInContext('serial(async () => { const s = await load(); S.replace(s, ["map::1", "map::2"]); await save(s); })', d.ctx);
  let fired = false;
  p.beforeResponse = async () => {
    if (!fired) {
      fired = true;
      await vm.runInContext('serial(async () => { const s = await load(); S.replace(s, ["map::1"]); await save(s); })', d.ctx);
    }
  };
  await p.capture(); await p.capture();
  assert.deepEqual(p.found(), ["map::1"]);
  assert.deepEqual(d.data.backup.found, ["map::1"]);
});

test("two tabs sharing site storage do not turn mirrored changes into user edits", async () => {
  const d = device(cloud()), values = new Map();
  const p = d.page(["map::1"], { values });
  const q = d.page(["map::1"], { values });
  await p.capture(); await q.capture();
  await d.ok({ type: "progress-apply", mode: "replace", found: ["map::2"] });
  await Promise.all([p.capture(), q.capture()]);
  assert.deepEqual(p.found(), ["map::2"]);
  assert.deepEqual(d.data.backup.found, ["map::2"]);
});

test("restart retains queued offline changes and device identity", async () => {
  const remote = cloud(), a = device(remote), p = a.page(["map::1"]);
  await p.capture(); await a.enable();
  p.edit(["map::offline"]); await p.capture();
  const b = device(remote, a.data), q = b.page(p.found(), { values: new Map(p.values) });
  await q.capture(); await b.sync();
  assert.equal(b.data.syncState.device, a.data.syncState.device);
  assert.deepEqual(b.data.backup.found, ["map::offline"]);
});

test("disconnect during an in-flight download prevents upload and late re-login", async () => {
  const remote = cloud();
  let started, release;
  const ready = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const normal = remote.fetch.bind(remote);
  remote.fetch = async (url, options) => {
    if (url.includes("/drive/v3/files?")) { started(); await gate; }
    return normal(url, options);
  };
  const d = device(remote);
  d.data.driveAuth = { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600000 };
  const pending = d.send({ type: "drive-sync" });
  await ready;
  await d.ok({ type: "drive-disconnect" });
  release();
  assert.ok((await pending).error);
  assert.equal(remote.files.size, 0);
  assert.equal(d.data.driveAuth, undefined);
  assert.equal(d.data.driveStatus.connected, false);
});

function oauthHarness(mode = "ok") {
  const tokenCalls = [];
  let authURL;
  const browser = { identity: {
    getRedirectURL: () => "https://extension-id.extensions.allizom.org/",
    launchWebAuthFlow: async ({ url }) => {
      authURL = new URL(url);
      const redirect = new URL(authURL.searchParams.get("redirect_uri"));
      redirect.searchParams.set("state", mode === "bad-state" ? "wrong" : authURL.searchParams.get("state"));
      redirect.searchParams.set("code", "authorization-code");
      return redirect.href;
    },
  } };
  const ctx = vm.createContext({ browser, crypto, URL, URLSearchParams, TextEncoder, Uint8Array, btoa, AbortSignal,
    WUWA_OAUTH: { clientId: "123-test.apps.googleusercontent.com", clientSecret: "public-desktop-config" },
    fetch: async (url, options) => {
      tokenCalls.push({ url, params: new URLSearchParams(options.body) });
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600,
        scope: mode === "wrong-scope" ? "email" : "https://www.googleapis.com/auth/drive.appdata" });
    },
  });
  run(ctx, "google-drive.js");
  return { ctx, tokenCalls, get authURL() { return authURL; } };
}

test("Google login uses PKCE, validates state, and requests offline appdata only", async () => {
  const h = oauthHarness();
  const auth = await h.ctx.WuwaDrive.authorize();
  assert.equal(auth.refreshToken, "refresh");
  assert.equal(h.authURL.searchParams.get("access_type"), "offline");
  assert.equal(h.authURL.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.appdata");
  assert.equal(h.authURL.searchParams.get("code_challenge_method"), "S256");
  const verifier = h.tokenCalls[0].params.get("code_verifier");
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  assert.equal(h.authURL.searchParams.get("code_challenge"), hash);
  assert.equal(h.tokenCalls[0].params.get("redirect_uri"), "http://127.0.0.1/mozoauth2/extension-id");
});

test("forged OAuth state is rejected without exchanging the code", async () => {
  const h = oauthHarness("bad-state");
  await assert.rejects(h.ctx.WuwaDrive.authorize(), /проверить ответ/);
  assert.equal(h.tokenCalls.length, 0);
});

test("missing Drive permission in OAuth response is rejected", async () => {
  const h = oauthHarness("wrong-scope");
  await assert.rejects(h.ctx.WuwaDrive.authorize(), /не предоставил доступ/);
});

test("reinstall with old site metadata keeps existing site progress", async () => {
  const a = device(cloud()), p = a.page(["map::1"]);
  await p.capture();
  await a.ok({ type: "progress-apply", mode: "replace", found: ["map::2"] });
  await p.capture();
  assert.ok(p.values.get("wuwa-map-progress-applied"));
  const b = device(cloud()), q = b.page(p.found(), { values: new Map(p.values) });
  await q.capture();
  assert.deepEqual(q.found(), ["map::2"]);
  assert.deepEqual(b.data.backup.found, ["map::2"]);
  assert.notEqual(a.data.syncState.device, b.data.syncState.device);
});

test("popup initializes and preserves file import and Drive controls", async () => {
  const d = device(cloud()), p = d.page(["map::1"]);
  await p.capture();
  const elements = new Map([...source("popup.html").matchAll(/id="([^"]+)"/g)].map((m) => ["#" + m[1], element()]));
  function element() {
    return { dataset: {}, listeners: {}, textContent: "", files: [], hidden: false,
      addEventListener(type, fn) { this.listeners[type] = fn; },
      replaceChildren() {}, append() {}, click() {}, remove() {} };
  }
  const base = d.ctx.browser;
  const browser = { ...base, storage: { ...base.storage, onChanged: event() },
    runtime: { ...base.runtime, sendMessage: d.send },
    permissions: { ...base.permissions, request: async () => true } };
  const ctx = vm.createContext({ browser, URL, URLSearchParams, Blob,
    location: { search: "?tab=1" }, confirm: () => true, window: { close() {} },
    document: { querySelector(selector) {
      assert.ok(elements.has(selector), "Missing popup element " + selector);
      return elements.get(selector);
    }, createElement: element, body: element() },
  });
  for (const f of ["lib.js", "oauth-config.js", "google-drive.js", "popup.js"]) run(ctx, f);
  await vm.runInContext("initialize()", ctx);
  assert.equal(elements.get("#drive-line").textContent, "Не подключён");
  assert.equal(elements.get("#drive-sync").disabled, true);
  ctx.WUWA_OAUTH = { clientId: "", clientSecret: "" };
  await elements.get("#drive-connect").listeners.click();
  assert.match(elements.get("#status").textContent, /не настроен вход Google/);
  await elements.get("#replace").listeners.click();
  elements.get("#file").files = [{ text: async () => '["map::imported"]' }];
  await elements.get("#file").listeners.change();
  await p.capture();
  assert.deepEqual(d.data.backup.found, ["map::imported"]);
  await elements.get("#merge").listeners.click();
  elements.get("#file").files = [{ text: async () => '["map::extra"]' }];
  await elements.get("#file").listeners.change();
  await p.capture();
  assert.deepEqual(d.data.backup.found, ["map::extra", "map::imported"]);
});
