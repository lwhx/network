import { AsyncLocalStorage } from "node:async_hooks";

import { HttpError } from "../../lib/http-error.js";

const missingCredentialMessage =
  "缺少 Cloudflare 凭据。请先完成首次初始化，并在面板中保存 Cloudflare 登录邮箱和 Global API Key。";

export class CloudflareClient {
  constructor({ apiBaseUrl, email, globalApiKey, requestTimeoutMs, fetchImpl = fetch }) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.email = email;
    this.globalApiKey = globalApiKey;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.credentialContext = new AsyncLocalStorage();
  }

  setCredentials({ email, globalApiKey }) {
    this.email = email;
    this.globalApiKey = globalApiKey;
  }

  getBaseCredentials() {
    return {
      email: this.email,
      globalApiKey: this.globalApiKey,
    };
  }

  hasBaseCredentials() {
    return Boolean(this.email && this.globalApiKey);
  }

  getCredentials() {
    const scopedCredentials = this.credentialContext.getStore();

    if (scopedCredentials?.email && scopedCredentials?.globalApiKey) {
      return scopedCredentials;
    }

    return this.getBaseCredentials();
  }

  withCredentials(credentials, callback) {
    if (!credentials?.email || !credentials?.globalApiKey) {
      return callback();
    }

    return this.credentialContext.run(
      {
        email: credentials.email,
        globalApiKey: credentials.globalApiKey,
      },
      callback
    );
  }

  hasCredentials() {
    const credentials = this.getCredentials();
    return Boolean(credentials.email && credentials.globalApiKey);
  }

  async get(path, searchParams = {}) {
    return this.send("GET", path, { searchParams });
  }

  async post(path, body = {}) {
    return this.send("POST", path, { body });
  }

  async patch(path, body = {}) {
    return this.send("PATCH", path, { body });
  }

  async put(path, body = {}) {
    return this.send("PUT", path, { body });
  }

  async delete(path) {
    return this.send("DELETE", path);
  }

  async deleteAny(path) {
    if (!this.hasCredentials()) {
      throw new HttpError(412, missingCredentialMessage);
    }

    const response = await this.request(this.makeUrl(path), {
      method: "DELETE",
      serializeJson: false,
    });

    if (!response.ok) {
      throw new HttpError(
        response.status,
        await this.readErrorMessage(response, `Cloudflare API 请求失败 (${response.status})`)
      );
    }

    const payload = await response.json().catch(() => null);

    if (payload && payload.success === false) {
      const cloudflareMessage =
        payload.errors
          ?.map((item) => item.message)
          .filter(Boolean)
          .join("；") || `Cloudflare API 请求失败 (${response.status})`;

      throw new HttpError(response.status, cloudflareMessage);
    }

    return payload || { success: true };
  }

  async getText(path, searchParams = {}) {
    if (!this.hasCredentials()) {
      throw new HttpError(412, missingCredentialMessage);
    }

    const url = this.makeUrl(path, searchParams);
    const response = await this.request(url, {
      method: "GET",
      headers: { Accept: "*/*" },
      serializeJson: false,
    });

    if (!response.ok) {
      throw new HttpError(
        response.status,
        await this.readErrorMessage(response, `Cloudflare API 请求失败 (${response.status})`)
      );
    }

    return response.text();
  }

  async putMultipart(path, formData) {
    if (!this.hasCredentials()) {
      throw new HttpError(412, missingCredentialMessage);
    }

    const response = await this.request(this.makeUrl(path), {
      method: "PUT",
      body: formData,
      serializeJson: false,
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.success) {
      const cloudflareMessage =
        payload?.errors
          ?.map((item) => item.message)
          .filter(Boolean)
          .join("；") || `Cloudflare API 请求失败 (${response.status})`;

      throw new HttpError(response.status, cloudflareMessage);
    }

    return payload;
  }

  async getRaw(path, searchParams = {}, headers = {}) {
    return this.sendRaw("GET", path, { searchParams, headers });
  }

  async postRaw(path, body, headers = {}) {
    return this.sendRaw("POST", path, { body, headers });
  }

  async putRaw(path, body, headers = {}) {
    return this.sendRaw("PUT", path, { body, headers });
  }

  async sendRaw(method, path, { searchParams = {}, body, headers = {} } = {}) {
    if (!this.hasCredentials()) {
      throw new HttpError(412, missingCredentialMessage);
    }

    const response = await this.request(this.makeUrl(path, searchParams), {
      method,
      body,
      headers,
      serializeJson: false,
    });

    if (!response.ok) {
      throw new HttpError(
        response.status,
        await this.readErrorMessage(response, `Cloudflare API 请求失败 (${response.status})`)
      );
    }

    return response;
  }

  async graphql(query, variables = {}) {
    if (!this.hasCredentials()) {
      throw new HttpError(412, missingCredentialMessage);
    }

    const url = new URL("graphql", `${this.apiBaseUrl}/`);
    const response = await this.request(url, {
      method: "POST",
      body: { query, variables },
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || payload?.errors?.length) {
      const cloudflareMessage =
        payload?.errors
          ?.map((item) => item.message)
          .filter(Boolean)
          .join("；") || `Cloudflare GraphQL 请求失败 (${response.status})`;

      throw new HttpError(response.ok ? 502 : response.status, cloudflareMessage);
    }

    return payload?.data || {};
  }

  async send(method, path, { searchParams = {}, body } = {}) {
    if (!this.hasCredentials()) {
      throw new HttpError(412, missingCredentialMessage);
    }

    const url = this.makeUrl(path, searchParams);

    const response = await this.request(url, { method, body });
    const payload = await response.json().catch(() => null);

    if (response.ok && response.status === 204 && !payload) {
      return { success: true, result: null };
    }

    if (!response.ok || !payload?.success) {
      const cloudflareMessage =
        payload?.errors
          ?.map((item) => item.message)
          .filter(Boolean)
          .join("；") || `Cloudflare API 请求失败 (${response.status})`;

      throw new HttpError(response.status, cloudflareMessage);
    }

    return payload;
  }

  makeUrl(path, searchParams = {}) {
    const url = new URL(path.replace(/^\/+/, ""), `${this.apiBaseUrl}/`);

    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  async readErrorMessage(response, fallbackMessage) {
    const payload = await response
      .clone()
      .json()
      .catch(() => null);

    if (payload?.errors?.length) {
      const cloudflareMessage = payload.errors
        .map((item) => item.message)
        .filter(Boolean)
        .join("；");

      if (cloudflareMessage) {
        return cloudflareMessage;
      }
    }

    const text = await response.text().catch(() => "");
    return text.trim() || fallbackMessage;
  }

  async request(url, { method = "GET", body, headers = {}, serializeJson = true } = {}) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.requestTimeoutMs);

    try {
      const credentials = this.getCredentials();
      const requestHeaders = {
        "X-Auth-Email": credentials.email,
        "X-Auth-Key": credentials.globalApiKey,
        ...headers,
      };

      if (serializeJson && body !== undefined && !requestHeaders["Content-Type"]) {
        requestHeaders["Content-Type"] = "application/json";
      }

      const requestOptions = {
        method,
        headers: requestHeaders,
        signal: abortController.signal,
      };

      if (body !== undefined) {
        requestOptions.body = serializeJson ? JSON.stringify(body) : body;
      }

      return await this.fetchImpl(url, requestOptions);
    } catch (cause) {
      const error = new HttpError(
        cause.name === "AbortError" ? 504 : 502,
        cause.name === "AbortError"
          ? "Cloudflare API 请求超时，请稍后重试。"
          : "无法连接 Cloudflare API，请检查网络或 API 地址。"
      );
      // A transport failure cannot prove that a remote write was rejected.
      error.remoteOutcomeUnknown = !["GET", "HEAD"].includes(method);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
