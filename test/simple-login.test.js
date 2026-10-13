import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { scryptSync } from "node:crypto";
import { SecretBox } from "../src/services/secret-box.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/bootstrap.js";
import { createConfig } from "../src/config/env.js";
import { CredentialSessionService } from "../src/services/credential-session-service.js";
import { PanelAuthService, generateTotpSecret } from "../src/services/panel-auth-service.js";
import { SqliteStore } from "../src/services/sqlite-store.js";
import { makeTotp } from "./helpers/panel-test-environment.js";

const password = "example-panel-password";
const username = "operator";

function authEnvironment(t, { totp = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cf-simple-login-"));
  const store = new SqliteStore({ databasePath: join(dir, "panel.sqlite"), secretKey: "test-secret-material" });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const auth = new PanelAuthService({ store });
  const secret = totp ? generateTotpSecret() : "";
  const result = auth.createPanelUserSetup({ username, password,
    ...(totp ? { totpSecret: secret, totpCode: makeTotp(secret) } : {}) });
  assert.equal(result.statusCode, 201);
  return { store, auth, secret };
}

test("new administrators can initialize and log in without binding a verifier", (t) => {
  const { store, auth } = authEnvironment(t);
  assert.equal(store.getPanelUser().totpEnabled, false);
  assert.equal(auth.verify({ user: username, password }), true);
  assert.equal(auth.verify({ user: username, password: "wrong" }), false);
  assert.equal(store.database.prepare("SELECT totp_secret FROM panel_user").get().totp_secret, "");
});

test("existing verifier credentials stay enabled after opening the database again", (t) => {
  const { store, auth, secret } = authEnvironment(t, { totp: true });
  const reopened = new SqliteStore({ databasePath: store.databasePath, secretKey: "test-secret-material" });
  try {
    const reopenedAuth = new PanelAuthService({ store: reopened });
    assert.equal(reopened.getPanelUser().totpEnabled, true);
    assert.equal(reopenedAuth.verify({ user: username, password }), false);
    assert.equal(reopenedAuth.verify({ user: username, password, auth: makeTotp(secret) }), true);
    assert.equal(auth.verify({ user: username, password, auth: "000000" }), false);
  } finally { reopened.close(); }
});

test("the original schema migrates without losing the existing password or 2FA", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cf-legacy-auth-"));
  const databasePath = join(dir, "panel.sqlite");
  const secret = generateTotpSecret();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE panel_user (id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
    totp_secret TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  const salt = "legacy-password-salt";
  legacy.prepare("INSERT INTO panel_user VALUES (1, ?, ?, ?, ?, ?, ?)").run(username,
    scryptSync(password, salt, 64).toString("base64url"), salt,
    new SecretBox({ keyMaterial: "legacy-key" }).encrypt(secret.replace(/\s/g, "")),
    new Date().toISOString(), new Date().toISOString());
  legacy.close();
  const store = new SqliteStore({ databasePath, secretKey: "legacy-key" });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const auth = new PanelAuthService({ store });
  assert.equal(auth.verify({ user: username, password }), false);
  assert.equal(auth.verify({ user: username, password, auth: makeTotp(secret) }), true);
  const session = new CredentialSessionService({ store }).create({ authenticated: true });
  assert.ok(new CredentialSessionService({ store }).resolve({ headers: { cookie: `cf_panel_session=${session.id}` } }));
});

test("explicit verifier setup cannot silently downgrade invalid input", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cf-optional-totp-"));
  const store = new SqliteStore({ databasePath: join(dir, "panel.sqlite") });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const auth = new PanelAuthService({ store });
  const result = auth.createPanelUserSetup({ username, password, totpEnabled: true });
  assert.equal(result.statusCode, 400);
  assert.equal(store.hasPanelUser(), false);
  assert.equal(auth.createPanelUserSetup({ username, password, totpEnabled: "false" }).statusCode, 400);
});

test("remembered sessions survive service restart with account selection and CSRF intact", (t) => {
  const { store } = authEnvironment(t);
  const first = new CredentialSessionService({ store });
  const session = first.create({ authenticated: true, source: "panel", activeCloudflareAccountId: "cf_2" });
  const request = { headers: { cookie: `cf_panel_session=${session.id}` } };
  const second = new CredentialSessionService({ store });
  assert.equal(second.resolve(request)?.authenticated, true);
  assert.equal(second.resolve(request)?.activeCloudflareAccountId, "cf_2");
  assert.equal(second.resolve(request)?.expiresAt, session.expiresAt);
  assert.equal(second.verifyCsrf({ headers: { ...request.headers, "x-csrf-token": session.csrfToken } }), true);
  const row = store.database.prepare("SELECT * FROM panel_sessions").get();
  assert.ok(row);
  assert.doesNotMatch(JSON.stringify(row), new RegExp(session.id));
  assert.equal(Object.hasOwn(row, "global_api_key"), false);
  assert.equal(Object.hasOwn(row, "password"), false);
});

test("session-only login does not persist or issue a long-lived browser cookie", (t) => {
  const { store } = authEnvironment(t);
  const first = new CredentialSessionService({ store });
  const session = first.create({ authenticated: true, remember: false });
  const request = { headers: { cookie: `cf_panel_session=${session.id}` }, socket: {} };
  assert.equal(first.resolve(request)?.authenticated, true);
  assert.doesNotMatch(first.createCookie(request, session), /Max-Age|Expires=/);
  assert.equal(new CredentialSessionService({ store }).resolve(request), null);
  assert.equal(store.database.prepare("SELECT count(*) AS count FROM panel_sessions").get().count, 0);
});

test("logout and expiry invalidate persisted sessions in every service instance", (t) => {
  const { store } = authEnvironment(t);
  let now = Date.now();
  const first = new CredentialSessionService({ store, ttlDays: 1, now: () => now });
  const second = new CredentialSessionService({ store, now: () => now });
  const session = first.create({ authenticated: true });
  const request = { headers: { cookie: `cf_panel_session=${session.id}` } };
  assert.ok(second.resolve(request));
  first.revoke(request);
  assert.equal(second.resolve(request), null);
  const expiring = first.create({ authenticated: true });
  now += 86_400_001;
  assert.equal(second.resolve({ headers: { cookie: `cf_panel_session=${expiring.id}` } }), null);
});

test("a concurrent account-selection update cannot recreate a logged-out session", (t) => {
  const { store } = authEnvironment(t);
  const secondStore = new SqliteStore({ databasePath: store.databasePath, secretKey: "test-secret-material" });
  t.after(() => secondStore.close());
  const first = new CredentialSessionService({ store });
  const second = new CredentialSessionService({ store: secondStore });
  const session = first.create({ authenticated: true });
  const request = { headers: { cookie: `cf_panel_session=${session.id}` } };
  const originalResolve = first.resolve.bind(first);
  first.resolve = (request) => {
    const resolved = originalResolve(request);
    second.revoke(request);
    return resolved;
  };
  assert.equal(first.update(request, { activeCloudflareAccountId: "cf_2" }), null);
  assert.equal(second.resolve(request), null);
});

test("a login authenticated before 2FA changes cannot mint a session under the new revision", (t) => {
  const { store, auth } = authEnvironment(t);
  const verification = auth.authenticate({ user: username, password });
  const secret = generateTotpSecret();
  assert.equal(auth.updateTwoFactor({ enabled: true, password, totpSecret: secret, totpCode: makeTotp(secret) }).statusCode, 200);
  const sessions = new CredentialSessionService({ store });
  assert.throws(() => sessions.create({ authenticated: true, authRevision: verification.authRevision }), /登录设置已更新/);
  assert.equal(store.database.prepare("SELECT count(*) AS count FROM panel_sessions").get().count, 0);
});

test("admin reset invalidates old cookies even when manual SQL left session rows behind", (t) => {
  const { store, auth } = authEnvironment(t);
  const service = new CredentialSessionService({ store });
  const old = service.create({ authenticated: true });
  store.database.exec("PRAGMA foreign_keys = OFF; DELETE FROM panel_user;");
  assert.equal(auth.createPanelUserSetup({ username, password }).statusCode, 201);
  assert.equal(service.resolve({ headers: { cookie: `cf_panel_session=${old.id}` } }), null);
});

test("disabling 2FA requires the password and existing verifier, and revokes old sessions", (t) => {
  const { store, auth, secret } = authEnvironment(t, { totp: true });
  const sessions = new CredentialSessionService({ store });
  const old = sessions.create({ authenticated: true });
  assert.equal(auth.updateTwoFactor({ enabled: false, password }).statusCode, 401);
  assert.equal(store.getPanelUser().totpEnabled, true);
  assert.equal(auth.updateTwoFactor({ enabled: false, password: "wrong", auth: makeTotp(secret) }).statusCode, 401);
  assert.equal(auth.updateTwoFactor({ enabled: false, password, auth: makeTotp(secret) }).statusCode, 200);
  assert.equal(store.getPanelUser().totpEnabled, false);
  assert.equal(sessions.resolve({ headers: { cookie: `cf_panel_session=${old.id}` } }), null);
  assert.equal(auth.verify({ user: username, password }), true);
});

test("optional 2FA can only be enabled after verifying the new secret", (t) => {
  const { store, auth } = authEnvironment(t);
  const secret = generateTotpSecret();
  assert.equal(auth.updateTwoFactor({ enabled: true, password, totpSecret: secret, totpCode: "wrong" }).statusCode, 400);
  assert.equal(store.getPanelUser().totpEnabled, false);
  assert.equal(auth.updateTwoFactor({ enabled: true, password, totpSecret: secret, totpCode: makeTotp(secret) }).statusCode, 200);
  assert.equal(auth.verify({ user: username, password }), false);
  assert.equal(auth.verify({ user: username, password, auth: makeTotp(secret) }), true);
});

async function startHttpPanel(dir) {
  const container = createContainer(createConfig({ DATA_DIR: dir, SETUP_TOKEN: "one-time-setup-token" }));
  const server = createServer(container.app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { origin: `http://127.0.0.1:${server.address().port}`, container,
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); container.sqliteStore.close(); } };
}

test("HTTP login survives panel restart and 2FA changes rotate cookies with CSRF enforcement", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cf-simple-http-"));
  let panel = await startHttpPanel(dir);
  t.after(async () => { await panel.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = async (path, { method = "GET", body, cookie = "", csrf = "" } = {}) => {
    const response = await fetch(`${panel.origin}${path}`, { method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { response, payload: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  assert.equal((await call("/api/setup/admin", { method: "POST", body: { username, password, setupToken: "wrong" } })).response.status, 401);
  const setup = await call("/api/setup/admin", { method: "POST", body: { username, password, setupToken: "one-time-setup-token" } });
  assert.equal(setup.response.status, 201);
  assert.equal((await call("/api/session/status", { cookie: setup.cookie })).payload.totpEnabled, false);
  const accounts = await call("/api/setup/cloudflare-accounts", { method: "POST", cookie: setup.cookie,
    csrf: setup.payload.csrfToken, body: { accounts: [{ cfEmail: "demo@example.com", cfApiKey: "example-global-key" }] } });
  assert.equal(accounts.response.status, 201);
  const selected = accounts.payload.activeCloudflareAccount.id;
  await panel.close();
  panel = await startHttpPanel(dir);
  const restored = await call("/api/session/status", { cookie: setup.cookie });
  assert.equal(restored.payload.authenticated, true);
  assert.equal(restored.payload.activeCloudflareAccount.id, selected);
  assert.equal(restored.payload.csrfToken, setup.payload.csrfToken);
  const login = await call("/api/session/connect", { method: "POST", body: { user: username, password } });
  assert.equal(login.response.status, 200);
  const secret = await call("/api/session/security/secret", { method: "POST", cookie: login.cookie,
    csrf: login.payload.csrfToken, body: { password } });
  assert.equal(secret.response.status, 200);
  const update = { enabled: true, password, totpSecret: secret.payload.secret, totpCode: makeTotp(secret.payload.secret) };
  const blocked = await call("/api/session/security", { method: "PUT", cookie: login.cookie, body: update });
  assert.equal(blocked.response.status, 403);
  const enabled = await call("/api/session/security", { method: "PUT", cookie: login.cookie,
    csrf: login.payload.csrfToken, body: update });
  assert.equal(enabled.response.status, 200);
  assert.notEqual(enabled.cookie, login.cookie);
  assert.equal((await call("/api/session/status", { cookie: setup.cookie })).payload.authenticated, false);
  assert.equal((await call("/api/session/status", { cookie: login.cookie })).payload.authenticated, false);
  assert.equal((await call("/api/session/status", { cookie: enabled.cookie })).payload.authenticated, true);
  assert.equal((await call("/api/session/connect", { method: "POST", body: { user: username, password } })).response.status, 400);
  const disabled = await call("/api/session/security", { method: "PUT", cookie: enabled.cookie,
    csrf: enabled.payload.csrfToken, body: { enabled: false, password, auth: makeTotp(secret.payload.secret) } });
  assert.equal(disabled.response.status, 200);
  assert.equal((await call("/api/session/connect", { method: "POST", body: { user: username, password } })).response.status, 200);
  const logout = await call("/api/session/logout", { method: "POST", cookie: disabled.cookie, csrf: disabled.payload.csrfToken });
  assert.equal(logout.response.status, 200);
  await panel.close();
  panel = await startHttpPanel(dir);
  assert.equal((await call("/api/session/status", { cookie: disabled.cookie })).payload.authenticated, false);
});
