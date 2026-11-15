(function (root) {
  const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
  const API = "https://www.googleapis.com/drive/v3/files";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
  const PREFIX = "wuwa-map-progress-v2-";
  const CONSENT = { data_collection: ["websiteActivity", "authenticationInfo"] };

  async function request(url, options = {}) {
    try {
      return await fetch(url, { ...options, credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(30000) });
    } catch {
      throw new Error("Нет связи с Google. Локальные изменения сохранены; повтор — автоматически.");
    }
  }

  function config() {
    const c = root.WUWA_OAUTH;
    if (!/^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(c?.clientId || "")) {
      throw new Error("В этой сборке ещё не настроен вход Google. Нужен OAuth-клиент разработчика.");
    }
    return c;
  }

  function base64(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function tokenRequest(params) {
    const c = config();
    const body = new URLSearchParams({ client_id: c.clientId, ...params });
    if (c.clientSecret) body.set("client_secret", c.clientSecret);
    const res = await request("https://oauth2.googleapis.com/token", { method: "POST", body });
    const data = await res.json();
    if (!res.ok) {
      if (data.error === "invalid_grant") throw new Error("Доступ Google истёк или отозван. Подключите аккаунт заново.");
      throw new Error("Google не выдал доступ: " + String(data.error || res.status).slice(0, 100));
    }
    if (typeof data.access_token !== "string" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
        (data.scope && !data.scope.split(" ").includes(SCOPE))) {
      throw new Error("Google не предоставил доступ к данным расширения в Drive");
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }

  async function authorize() {
    const c = config();
    const verifier = base64(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = base64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const state = base64(crypto.getRandomValues(new Uint8Array(32)));
    const redirect = "http://127.0.0.1/mozoauth2/" + new URL(browser.identity.getRedirectURL()).hostname.split(".")[0];
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: c.clientId, redirect_uri: redirect, response_type: "code", scope: SCOPE,
      access_type: "offline", prompt: "consent select_account", state,
      code_challenge: challenge, code_challenge_method: "S256",
    });
    let response;
    try {
      response = new URL(await browser.identity.launchWebAuthFlow({ url: url.href, interactive: true }));
    } catch {
      throw new Error("Вход Google отменён или не завершился");
    }
    if (response.origin + response.pathname !== redirect || response.searchParams.get("state") !== state) {
      throw new Error("Не удалось проверить ответ Google");
    }
    if (response.searchParams.has("error")) throw new Error("Разрешение Google не получено");
    const code = response.searchParams.get("code");
    if (!code) throw new Error("Google не вернул код авторизации");
    const auth = await tokenRequest({ code, code_verifier: verifier, redirect_uri: redirect, grant_type: "authorization_code" });
    if (!auth.refreshToken) throw new Error("Google не выдал постоянный доступ. Повторите подключение.");
    return auth;
  }

  async function refresh(auth) {
    if (!auth?.refreshToken) throw new Error("Подключите Google Drive");
    const next = await tokenRequest({ refresh_token: auth.refreshToken, grant_type: "refresh_token" });
    return { ...auth, ...next, refreshToken: next.refreshToken || auth.refreshToken };
  }

  class Drive {
    constructor(auth, onRefresh, check) {
      this.auth = auth;
      this.onRefresh = onRefresh;
      this.check = check;
    }

    async call(url, options = {}, retry = true) {
      this.check();
      if (this.auth.expiresAt < Date.now() + 60000) {
        this.auth = await refresh(this.auth);
        this.check();
        await this.onRefresh(this.auth);
      }
      const res = await request(url, { ...options, headers: { ...options.headers, Authorization: "Bearer " + this.auth.accessToken } });
      this.check();
      if (res.status === 401 && retry) {
        this.auth.expiresAt = 0;
        return this.call(url, options, false);
      }
      if (!res.ok) {
        const error = new Error(res.status === 403 ? "Google Drive отказал в доступе. Проверьте разрешения и включение Drive API." : "Ошибка Google Drive: HTTP " + res.status);
        error.status = res.status;
        throw error;
      }
      return res;
    }

    async list() {
      const files = [];
      let pageToken = "";
      do {
        const params = new URLSearchParams({ spaces: "appDataFolder", q: "trashed = false and name contains '" + PREFIX + "'",
          fields: "nextPageToken,files(id,name,appProperties)", pageSize: "100", pageToken });
        const data = await (await this.call(API + "?" + params)).json();
        if (!Array.isArray(data.files)) throw new Error("Google Drive вернул некорректный список файлов");
        files.push(...data.files);
        if (files.length > 1000) throw new Error("Слишком много файлов синхронизации в Drive");
        pageToken = data.nextPageToken || "";
      } while (pageToken);
      return files;
    }

    async read(id) {
      const response = await this.call(API + "/" + encodeURIComponent(id) + "?alt=media");
      const text = await response.text();
      if (text.length > 16 * 1024 * 1024) throw new Error("Файл синхронизации слишком большой");
      try { return root.WuwaSync.validate(JSON.parse(text)); }
      catch { throw new Error("Повреждён файл синхронизации в Drive. Данные не перезаписаны."); }
    }

    async write(id, payload) {
      if (id) {
        await this.call(UPLOAD + "/" + encodeURIComponent(id) + "?uploadType=media", {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        return id;
      }
      const boundary = "wuwa_" + crypto.randomUUID();
      const metadata = { name: PREFIX + payload.device + ".json", parents: ["appDataFolder"],
        mimeType: "application/json", appProperties: { app: root.WuwaSync.APP, device: payload.device } };
      const body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(metadata) +
        "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + JSON.stringify(payload) + "\r\n--" + boundary + "--\r\n";
      const data = await (await this.call(UPLOAD + "?uploadType=multipart&fields=id", {
        method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body,
      })).json();
      if (typeof data.id !== "string") throw new Error("Google Drive не подтвердил сохранение файла");
      return data.id;
    }
  }

  root.WuwaDrive = { CONSENT, config, authorize, Drive };
})(globalThis);
