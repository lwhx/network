import { test } from "node:test";
import assert from "node:assert/strict";
import { state, resetSessionState } from "../public/js/state.js";
import { renderConnectView } from "../public/js/views/connect-view.js";
import { renderShell } from "../public/js/views/shell-view.js";
import { createSessionActions } from "../public/js/actions/session-actions.js";
import { createLoginSettingsActions } from "../public/js/actions/login-settings-actions.js";
import { setCsrfToken, updateLoginSettings } from "../public/js/api.js";

function uiEnvironment(t, fields = {}) {
  const before = { document: global.document, FormData: global.FormData, fetch: global.fetch };
  const app = { innerHTML: "", className: "" };
  const form = { querySelector(selector) {
    const name = selector.match(/name="([^"]+)"/)?.[1];
    return fields[name] || null;
  } };
  global.document = { querySelector: (selector) => selector === "#app" ? app : form };
  global.FormData = class { get(name) { return fields[name]?.value ?? null; } };
  resetSessionState();
  state.checkingSession = false;
  t.after(() => { Object.assign(global, before); resetSessionState(); });
  return { app, fields };
}

test("initialization defaults to password setup and only expands optional verifier fields when selected", (t) => {
  const { app } = uiEnvironment(t);
  state.setupRequired = true;
  state.setupStep = "admin";
  renderConnectView();
  assert.match(app.innerHTML, /id="setup-use-2fa"/);
  assert.doesNotMatch(app.innerHTML, /name="totpCode"/);
  assert.doesNotMatch(app.innerHTML, /创建管理员并进入下一步[^]*?disabled/);
  state.setupUseTwoFactor = true;
  renderConnectView();
  assert.match(app.innerHTML, /name="totpCode"/);
});

test("login hides unused verifier input and offers remembered login by default", (t) => {
  const { app } = uiEnvironment(t);
  state.totpEnabled = false;
  renderConnectView();
  assert.doesNotMatch(app.innerHTML, /name="auth"/);
  assert.match(app.innerHTML, /name="remember"[^>]*checked/);
  state.totpEnabled = true;
  renderConnectView();
  assert.match(app.innerHTML, /name="auth"/);
});

test("password-only login sends the selected remember preference and accepts a saved cookie", async (t) => {
  uiEnvironment(t, { user: { value: "operator" }, password: { value: "example-password" }, remember: { value: null } });
  state.totpEnabled = false;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify({ authenticated: true, hasCredentials: true, totpEnabled: false,
      csrfToken: "csrf", setupRequired: false }), { headers: { "Content-Type": "application/json" } });
  };
  const actions = createSessionActions({ renderApp() {}, async loadZones() {} });
  await actions.connectSession({ preventDefault() {} });
  assert.equal(requests[0].url, "/api/session/connect");
  assert.equal(requests[0].body.auth, "");
  assert.equal(requests[0].body.remember, false);
  assert.equal(state.connected, true);
});

test("password-only initialization submits without requesting a verifier secret", async (t) => {
  uiEnvironment(t, { username: { value: "operator" }, password: { value: "example-password" },
    confirmPassword: { value: "example-password" }, setupToken: { value: "initial-token" } });
  state.setupRequired = true;
  state.setupStep = "admin";
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify({ authenticated: true, setupRequired: true, totpEnabled: false,
      setupState: { panelUserRequired: false, cloudflareAccountRequired: true }, csrfToken: "csrf" }),
      { headers: { "Content-Type": "application/json" } });
  };
  const actions = createSessionActions({ renderApp() {}, async loadZones() {} });
  await actions.completeSetup({ preventDefault() {} });
  assert.equal(requests[0].url, "/api/setup/admin");
  assert.equal(requests[0].body.totpEnabled, false);
  assert.equal(requests[0].body.totpSecret, "");
  assert.equal(state.setupStep, "cloudflare");
  assert.ok(requests.every((request) => request.url !== "/api/setup/secret"));
});

test("the login settings dialog exposes 2FA changes with password reauthentication", (t) => {
  const { app } = uiEnvironment(t);
  state.loginSettingsOpen = true;
  state.totpEnabled = true;
  state.loginSettingsEnabled = false;
  renderShell("<section>test</section>");
  assert.match(app.innerHTML, /id="login-settings-open"/);
  assert.match(app.innerHTML, /role="dialog"[^>]*aria-label="登录设置"/);
  assert.match(app.innerHTML, /name="password"/);
  assert.match(app.innerHTML, /name="auth"/);
  assert.doesNotMatch(app.innerHTML, /name="totpCode"/);
});

test("logout immediately shows the correct verifier input for the next login", async (t) => {
  const { app } = uiEnvironment(t);
  const previous = { history: global.history, location: global.location };
  global.history = { replaceState() {} };
  global.location = { pathname: "/" };
  t.after(() => Object.assign(global, previous));
  state.connected = true;
  state.sessionAuthenticated = true;
  state.totpEnabled = true;
  global.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith("/logout")
    ? { ok: true } : { authenticated: false, loginRequired: true, setupRequired: false, totpEnabled: true }),
    { headers: { "Content-Type": "application/json" } });
  const actions = createSessionActions({ renderApp: renderConnectView, async loadZones() {} });
  await actions.logoutSession();
  assert.equal(state.connected, false);
  assert.match(app.innerHTML, /name="auth"/);
});

test("a successful settings save consumes the rotated session before a failed status refresh", async (t) => {
  uiEnvironment(t, { password: { value: "current-password" }, auth: { value: "123456" } });
  state.connected = true;
  state.sessionAuthenticated = true;
  state.loginSettingsOpen = true;
  state.totpEnabled = true;
  state.loginSettingsEnabled = false;
  state.csrfToken = "old-csrf";
  setCsrfToken("old-csrf");
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url, headers: options.headers });
    if (String(url).endsWith("/status")) throw new Error("temporary network failure");
    return new Response(JSON.stringify({ authenticated: true, csrfToken: "new-csrf", totpEnabled: false,
      expiresAt: "2099-01-01T00:00:00Z" }), { headers: { "Content-Type": "application/json" } });
  };
  await createLoginSettingsActions({ renderApp() {} }).saveLoginSettings({ preventDefault() {} });
  assert.equal(state.csrfToken, "new-csrf");
  assert.equal(state.totpEnabled, false);
  assert.equal(state.loginSettingsOpen, false);
  assert.match(state.sessionError, /已保存/);
  await updateLoginSettings({ enabled: false });
  assert.equal(requests.at(-1).headers["X-CSRF-Token"], "new-csrf");
});
