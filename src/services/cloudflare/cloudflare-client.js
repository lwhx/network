import { AsyncLocalStorage } from "node:async_hooks";

import { HttpError } from "../../lib/http-error.js";

const missingCredentialMessage =
  "缺少 Cloudflare 凭据。请先完成首次初始化，并在面板中保存 Cloudflare 登录邮箱和 Global API Key。";

function upstreamMessage(errors, fallbackMessage) {
  if (!Array.isArray(errors)) return fallbackMessage;
  return errors.map(item => typeof item?.message === "string" ? item.message : "")
    .filter(Boolean).join("；") || fallbackMessage;
}

function responseError(response, message, { write = false, rejected = false } = {}) {
  const unknown = write && (response.status >= 500 || (response.ok && !rejected));
  const error = new HttpError(response.ok ? 502 : response.status,
    unknown ? `${message}；写入结果未确认，请先核查远端配置。` : message);
  error.remoteOutcomeUnknown = unknown;
  return error;
}

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
        accountId: credentials.accountId || "",
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
      throw responseError(response,
        await this.readErrorMessage(response, `Cloudflare API 请求失败 (${response.status})`),
        { write: true });
    }

    const payload = await response.json().catch(() => null);

    if (payload?.success === false) {
      throw responseError(response,
        upstreamMessage(payload.errors, `Cloudflare API 请求失败 (${response.status})`),
        { write: true, rejected: true });
    }
    if (response.status === 204 && !payload) return { success: true };
    if (!payload || payload.success !== true) {
      const error = new HttpError(502, "Cloudflare 删除请求结果无法确认，请核查远端配置。");
      error.remoteOutcomeUnknown = true;
      throw error;
    }
    return payload;
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

    if (!response.ok || payload?.success !== true) {
      throw responseError(response,
        upstreamMessage(payload?.errors, `Cloudflare API 请求失败 (${response.status})`),
        { write: true, rejected: payload?.success === false });
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
      throw responseError(response,
        await this.readErrorMessage(response, `Cloudflare API 请求失败 (${response.status})`),
        { write: !["GET", "HEAD"].includes(method) });
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
      readOnly: true,
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || (payload?.errors != null && (!Array.isArray(payload.errors) || payload.errors.length > 0)) ||
        !payload?.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
      throw responseError(response,
        upstreamMessage(payload?.errors, `Cloudflare GraphQL 请求失败 (${response.status})`));
    }

    return payload.data;
  }

  async send(method, path, { searchParams = {}, body } = {}) {
    if (!this.hasCredentials()) {
      throw new HttpError(412, missingCredentialMessage);
    }

    const url = this.makeUrl(path, searchParams);

    const response = await this.request(url, { method, body });
    const payload = await response.json().catch(() => null);

    if (response.ok && response.status === 204 && !payload) {
      return { success: true, result: null, httpStatus: 204 };
    }

    if (!response.ok || payload?.success !== true) {
      throw responseError(response,
        upstreamMessage(payload?.errors, `Cloudflare API 请求失败 (${response.status})`),
        { write: !["GET", "HEAD"].includes(method), rejected: payload?.success === false });
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

    const cloudflareMessage = upstreamMessage(payload?.errors, "");
    if (cloudflareMessage) return cloudflareMessage;

    const text = await response.text().catch(() => "");
    return text.trim() || fallbackMessage;
  }

  async request(url, { method = "GET", body, headers = {}, serializeJson = true, readOnly = false } = {}) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.requestTimeoutMs);
    let response;

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

      response = await this.fetchImpl(url, requestOptions);
      // fetch resolves at headers. Keep the deadline active until the body is
      // complete, including raw/text responses consumed by downstream services.
      const bytes = await response.arrayBuffer();
      return new Response(response.body === null ? null : bytes, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    } catch (cause) {
      const timedOut = abortController.signal.aborted || cause.name === "AbortError";
      if (response && !response.ok) {
        // An observed HTTP rejection remains definite even if its error detail
        // cannot be read. Server errors still cannot prove a write was rejected.
        throw responseError(response, `Cloudflare API 请求失败 (${response.status})`, {
          write: !readOnly && !["GET", "HEAD"].includes(method),
        });
      }
      const error = new HttpError(
        timedOut ? 504 : 502,
        !readOnly && !["GET", "HEAD"].includes(method)
          ? `${timedOut ? "Cloudflare API 请求超时" : "Cloudflare API 连接中断"}，写入结果未确认，请先核查远端配置。`
          : timedOut
          ? "Cloudflare API 请求超时，请稍后重试。"
          : "无法连接 Cloudflare API，请检查网络或 API 地址。"
      );
      // A transport failure cannot prove that a remote write was rejected.
      error.remoteOutcomeUnknown = !readOnly && !["GET", "HEAD"].includes(method);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
