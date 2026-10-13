import { randomBytes } from "node:crypto";
import { HttpError } from "../lib/http-error.js";

const defaultCookieName = "cf_panel_session";
const secondsPerDay = 24 * 60 * 60;
const defaultTtlDays = 30;
const maxTtlDays = 30;
const expiredCookieDate = "Thu, 01 Jan 1970 00:00:00 GMT";

function normalizeTtlDays(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultTtlDays;
  }

  return Math.min(Math.max(Math.floor(parsed), 1), maxTtlDays);
}

function parseCookies(cookieHeader = "") {
  const cookies = new Map();

  for (const part of String(cookieHeader).split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    const name = rawName?.trim();

    if (!name) {
      continue;
    }

    cookies.set(name, rawValue.join("=").trim());
  }

  return cookies;
}

function cookieParts({ cookieName, value, maxAgeSeconds, expiresAt, secure, remember = true }) {
  const parts = [
    `${cookieName}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (remember) parts.push(`Max-Age=${maxAgeSeconds}`, `Expires=${expiresAt}`);

  if (secure) {
    parts.push("Secure");
  }

  return parts;
}

function isSessionId(value) {
  return /^[A-Za-z0-9_-]{32,128}$/.test(String(value || ""));
}

function isHttpsOrigin(value = "") {
  try {
    return new URL(String(value || "")).protocol === "https:";
  } catch {
    return false;
  }
}

export class CredentialSessionService {
  constructor({
    cookieName = defaultCookieName,
    now = () => Date.now(),
    publicOrigin = "",
    secureCookies = false,
    ttlDays = defaultTtlDays,
    trustProxyHeaders = false,
    store = null,
  } = {}) {
    this.cookieName = cookieName;
    this.maxAgeDays = normalizeTtlDays(ttlDays);
    this.maxAgeSeconds = this.maxAgeDays * secondsPerDay;
    this.now = now;
    this.publicOriginIsHttps = isHttpsOrigin(publicOrigin);
    this.secureCookies = Boolean(secureCookies);
    this.sessions = new Map();
    this.store = store;
    this.trustProxyHeaders = Boolean(trustProxyHeaders);
  }

  create({ activeCloudflareAccountId = "", authenticated = false, email = "", globalApiKey = "", source = "browser", remember = true, authRevision }) {
    this.pruneExpired();

    const id = randomBytes(32).toString("base64url");
    const createdAtMs = this.now();
    const expiresAtMs = createdAtMs + this.maxAgeSeconds * 1000;
    const session = {
      activeCloudflareAccountId,
      authenticated: Boolean(authenticated),
      authRevision: authRevision ?? this.store?.getAuthRevision() ?? "",
      remember: remember !== false,
      createdAt: new Date(createdAtMs).toISOString(),
      csrfToken: randomBytes(32).toString("base64url"),
      email,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      globalApiKey,
      id,
      source,
    };

    if (this.store && session.authenticated && session.authRevision !== this.store.getAuthRevision()) {
      throw new HttpError(401, "账户登录设置已更新，请重新登录。");
    }
    if (this.store && session.authenticated && session.remember) {
      if (!this.store.createSession(session)) throw new HttpError(401, "账户登录设置已更新，请重新登录。");
    } else this.sessions.set(id, session);
    return session;
  }

  resolve(request) {
    const sessionId = this.readSessionId(request);

    if (!sessionId) {
      return null;
    }

    const session = this.store?.getSession(sessionId, this.now()) || this.sessions.get(sessionId);

    if (!session) {
      return null;
    }

    if (session.expiresAtMs <= this.now() || (this.store && session.authRevision !== this.store.getAuthRevision())) {
      this.sessions.delete(sessionId);
      this.store?.deleteSession(sessionId);
      return null;
    }

    return session;
  }

  getCredentials(request) {
    const session = this.resolve(request);

    if (!session) {
      return null;
    }

    return {
      activeCloudflareAccountId: session.activeCloudflareAccountId || "",
      authenticated: Boolean(session.authenticated),
      remember: session.remember,
      csrfToken: session.csrfToken || "",
      email: session.email,
      expiresAt: session.expiresAt,
      globalApiKey: session.globalApiKey,
      sessionId: session.id,
      source: session.source,
    };
  }

  revoke(request) {
    const sessionId = this.readSessionId(request);

    if (sessionId) {
      this.sessions.delete(sessionId);
      this.store?.deleteSession(sessionId);
    }

    return Boolean(sessionId);
  }

  update(request, updates = {}) {
    const session = this.resolve(request);

    if (!session) {
      return null;
    }

    if (Object.hasOwn(updates, "activeCloudflareAccountId")) {
      session.activeCloudflareAccountId = String(updates.activeCloudflareAccountId || "");
    }

    if (Object.hasOwn(updates, "authenticated")) {
      session.authenticated = Boolean(updates.authenticated);
    }

    if (!session.csrfToken) {
      session.csrfToken = randomBytes(32).toString("base64url");
    }
    if (this.store && session.authenticated && session.remember && !this.store.updateSession(session, this.now())) return null;

    return session;
  }

  verifyCsrf(request) {
    const session = this.resolve(request);

    if (!session?.authenticated || !session.csrfToken) {
      return false;
    }

    const submitted = String(
      request?.headers?.["x-csrf-token"] || request?.headers?.["X-CSRF-Token"] || ""
    ).trim();

    return Boolean(submitted && submitted === session.csrfToken);
  }

  createCookie(request, session) {
    return cookieParts({
      cookieName: this.cookieName,
      expiresAt: session.expiresAt,
      maxAgeSeconds: this.maxAgeSeconds,
      secure: this.shouldUseSecureCookie(request),
      value: session.id,
      remember: session.remember,
    }).join("; ");
  }

  clearCookie(request) {
    return cookieParts({
      cookieName: this.cookieName,
      expiresAt: expiredCookieDate,
      maxAgeSeconds: 0,
      secure: this.shouldUseSecureCookie(request),
      value: "",
    }).join("; ");
  }

  shouldUseSecureCookie(request) {
    if (this.secureCookies || this.publicOriginIsHttps || request?.socket?.encrypted) {
      return true;
    }

    if (!this.trustProxyHeaders) {
      return false;
    }

    const forwardedProto = String(request?.headers?.["x-forwarded-proto"] || "")
      .split(",")[0]
      .trim()
      .toLowerCase();

    return forwardedProto === "https";
  }

  readSessionId(request) {
    const cookies = parseCookies(request?.headers?.cookie || "");
    const value = cookies.get(this.cookieName);

    return isSessionId(value) ? value : "";
  }

  pruneExpired() {
    const now = this.now();
    this.store?.pruneSessions(now);

    for (const [id, session] of this.sessions) {
      if (session.expiresAtMs <= now) {
        this.sessions.delete(id);
      }
    }
  }
}
