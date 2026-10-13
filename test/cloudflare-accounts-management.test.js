import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { CloudflareAccountsController } from "../src/controllers/cloudflare-accounts-controller.js";
import { CloudflareAccountService } from "../src/services/cloudflare-account-service.js";
import { CloudflareClient } from "../src/services/cloudflare/cloudflare-client.js";
import { CredentialSessionService } from "../src/services/credential-session-service.js";
import { PanelAuthService } from "../src/services/panel-auth-service.js";
import { SqliteStore } from "../src/services/sqlite-store.js";

function environment(t) {
  const dir = mkdtempSync(join(tmpdir(), "cf-account-management-"));
  const store = new SqliteStore({ databasePath: join(dir, "panel.sqlite"), secretKey: "account-test-secret" });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const auth = new PanelAuthService({ store });
  assert.equal(auth.createPanelUserSetup({ username: "operator", password: "account-management-password" }).statusCode, 201);
  const first = store.createCloudflareAccount({ email: "first@example.com", globalApiKey: "first-secret-key", name: "First" });
  const second = store.createCloudflareAccount({ email: "second@example.com", globalApiKey: "second-secret-key", name: "Second" });
  const accounts = new CloudflareAccountService({ store });
  const sessions = new CredentialSessionService({ store });
  const session = sessions.create({ authenticated: true, activeCloudflareAccountId: first.id });
  return { store, auth, first, second, accounts, sessions, session };
}

test("account edits preserve blank keys and encrypt replacements under the same account ID", (t) => {
  const { store, first, second, accounts } = environment(t);
  assert.equal(typeof accounts.updateAccount, "function");
  accounts.updateAccount(first.id, { cloudflareName: "Renamed", cfEmail: "NEW@EXAMPLE.COM", cfApiKey: " " });
  const renamed = accounts.findAccount(first.id);
  assert.equal(renamed.name, "Renamed");
  assert.equal(renamed.email, "new@example.com");
  assert.equal(renamed.globalApiKey, first.globalApiKey);
  accounts.updateAccount(first.id, { cfApiKey: "replacement-secret-key" });
  assert.equal(accounts.findAccount(first.id).globalApiKey, "replacement-secret-key");
  const encrypted = store.database.prepare("SELECT global_api_key FROM cloudflare_accounts WHERE id = ?").get(first.id).global_api_key;
  assert.ok(!encrypted.includes("replacement-secret-key"));
  assert.equal(accounts.findAccount(second.id).globalApiKey, second.globalApiKey);
});

test("invalid and duplicate edits leave every saved account intact", (t) => {
  const { accounts, first } = environment(t);
  assert.equal(typeof accounts.updateAccount, "function");
  for (const [input, status] of [
    [{ cfEmail: "invalid" }, 400], [{ cfEmail: "" }, 400],
    [{ cfApiKey: "short" }, 400], [{ cfApiKey: "x".repeat(257) }, 400],
    [{ cfEmail: "SECOND@EXAMPLE.COM" }, 409], [{ cloudflareName: {} }, 400],
  ]) {
    assert.throws(() => accounts.updateAccount(first.id, input), (error) => error.statusCode === status);
    assert.deepEqual(accounts.findAccount(first.id), { email: first.email, globalApiKey: first.globalApiKey, id: first.id, name: first.name, source: "sqlite" });
  }
});

test("missing account IDs never update or delete the default account", (t) => {
  const { accounts, first } = environment(t);
  assert.equal(typeof accounts.deleteAccount, "function");
  for (const id of ["", "   ", "missing-account"]) {
    assert.throws(() => accounts.updateAccount(id, { cloudflareName: "Wrong" }), (error) => error.statusCode === 404);
    assert.throws(() => accounts.deleteAccount(id), (error) => error.statusCode === 404);
  }
  assert.equal(accounts.findAccount(first.id).name, "First");
  assert.equal(accounts.listAccounts().length, 2);
});

test("authenticated edit details expose the email but never the saved key", (t) => {
  const { accounts, first } = environment(t);
  assert.equal(typeof accounts.getEditableAccount, "function");
  const editable = accounts.getEditableAccount(first.id);
  assert.equal(editable.email, first.email);
  assert.equal(editable.hasApiKey, true);
  assert.ok(!JSON.stringify(editable).includes(first.globalApiKey));
  assert.equal(Object.hasOwn(editable, "globalApiKey"), false);
});

function requestFor(session, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.headers = { cookie: `cf_panel_session=${session.id}` };
  return request;
}

function controllerEnvironment(t, fetchImpl = async () => Response.json({ success: true, result: [], result_info: { total_count: 0 } })) {
  const env = environment(t);
  const client = new CloudflareClient({ apiBaseUrl: "https://cloudflare.invalid/client/v4", email: "base@example.com", globalApiKey: "base-secret-key", requestTimeoutMs: 1000, fetchImpl });
  const controller = new CloudflareAccountsController({
    cloudflareAccountService: env.accounts, cloudflareClient: client,
    credentialSessionService: env.sessions, panelAuthService: env.auth,
  });
  return { ...env, client, controller };
}

test("every account controller operation requires a live authenticated session", async (t) => {
  const { controller, first } = controllerEnvironment(t);
  for (const method of ["detail", "update", "delete", "test"]) {
    const request = Readable.from([]);
    request.headers = {};
    await assert.rejects(controller[method]({ request, params: { accountId: first.id } }), (error) => error.statusCode === 401);
  }
});

test("controller detail and edit responses contain editor fields and safe session status", async (t) => {
  const { controller, first, session } = controllerEnvironment(t);
  const detail = await controller.detail({ request: requestFor(session), params: { accountId: first.id } });
  assert.equal(detail.body.account.email, "first@example.com");
  assert.equal(detail.body.account.hasApiKey, true);
  const update = await controller.update({ request: requestFor(session, { cloudflareName: "Edited" }), params: { accountId: first.id } });
  assert.equal(update.statusCode, 200);
  assert.equal(update.body.account.name, "Edited");
  assert.equal(update.body.authenticated, true);
  assert.equal(update.body.activeCloudflareAccount.id, first.id);
  assert.equal(update.body.csrfToken, session.csrfToken);
  assert.equal(update.body.setupRequired, false);
  assert.equal(update.body.totpEnabled, false);
  assert.equal(update.body.hasCredentials, true);
  assert.ok(!JSON.stringify([detail, update]).includes(first.globalApiKey));
});

test("deleting the selected account selects a fallback and deleting the last account resumes account setup", async (t) => {
  const { controller, first, second, session, sessions, accounts } = controllerEnvironment(t);
  const firstDeletion = await controller.delete({ request: requestFor(session), params: { accountId: first.id } });
  assert.equal(firstDeletion.body.activeCloudflareAccount.id, second.id);
  assert.equal(firstDeletion.body.accounts.length, 1);
  assert.equal(sessions.resolve(requestFor(session)).activeCloudflareAccountId, second.id);
  const lastDeletion = await controller.delete({ request: requestFor(session), params: { accountId: second.id } });
  assert.equal(lastDeletion.statusCode, 200);
  assert.equal(lastDeletion.body.authenticated, true);
  assert.equal(lastDeletion.body.activeCloudflareAccount, null);
  assert.equal(lastDeletion.body.hasCredentials, false);
  assert.equal(lastDeletion.body.setupRequired, true);
  assert.deepEqual(lastDeletion.body.setupState, { cloudflareAccountRequired: true, panelUserRequired: false, setupRequired: true });
  assert.equal(sessions.resolve(requestFor(session)).activeCloudflareAccountId, "");
  assert.equal(accounts.hasAccounts(), false);
});

test("deleting a different account preserves the current selection", async (t) => {
  const { controller, first, second, session } = controllerEnvironment(t);
  const result = await controller.delete({ request: requestFor(session), params: { accountId: second.id } });
  assert.equal(result.body.activeCloudflareAccount.id, first.id);
});

test("connection tests use exact candidate credentials with a read-only zones probe and never save edits", async (t) => {
  const calls = [];
  const { controller, accounts, first, session, client } = controllerEnvironment(t, async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ success: true, result: [{ id: "zone-1", name: "sensitive-zone.example" }], result_info: { total_count: 9 } });
  });
  const stored = await controller.test({ request: requestFor(session), params: { accountId: first.id } });
  assert.equal(stored.body.ok, true);
  assert.equal(calls[0].options.headers["X-Auth-Email"], first.email);
  assert.equal(calls[0].options.headers["X-Auth-Key"], first.globalApiKey);
  const candidate = await controller.test({ request: requestFor(session, { cfEmail: "candidate@example.com", cfApiKey: "candidate-secret-key" }), params: { accountId: first.id } });
  assert.equal(candidate.body.zoneCount, 9);
  assert.equal(calls[1].options.headers["X-Auth-Email"], "candidate@example.com");
  assert.equal(calls[1].options.headers["X-Auth-Key"], "candidate-secret-key");
  assert.ok(calls.every(({ url, options }) => options.method === "GET" && new URL(url).pathname.endsWith("/zones") && new URL(url).searchParams.get("per_page") === "1"));
  assert.equal(accounts.findAccount(first.id).email, first.email);
  assert.equal(accounts.findAccount(first.id).globalApiKey, first.globalApiKey);
  assert.equal(client.getBaseCredentials().globalApiKey, "base-secret-key");
  assert.ok(!JSON.stringify([stored, candidate]).includes("secret-key"));
  assert.ok(!JSON.stringify(candidate).includes("sensitive-zone"));
});

test("failed connection tests preserve HTTP failures and never echo credential-bearing upstream errors", async (t) => {
  const { controller, first, session } = controllerEnvironment(t, async () => Response.json({ success: false, errors: [{ message: "Bad first-secret-key for first@example.com" }] }, { status: 403 }));
  const result = await controller.test({ request: requestFor(session), params: { accountId: first.id } });
  assert.equal(result.statusCode, 403);
  assert.ok(result.body.error);
  assert.equal(result.body.ok, false);
  assert.ok(!JSON.stringify(result).includes(first.globalApiKey));
});

test("missing or invalid connection test candidates cannot probe the base account", async (t) => {
  let calls = 0;
  const { controller, first, session } = controllerEnvironment(t, async () => { calls += 1; return Response.json({ success: true, result: [] }); });
  for (const id of ["", "   ", "missing"]) {
    await assert.rejects(controller.test({ request: requestFor(session), params: { accountId: id } }), (error) => error.statusCode === 404);
  }
  await assert.rejects(controller.test({ request: requestFor(session, { cfEmail: "invalid" }), params: { accountId: first.id } }), (error) => error.statusCode === 400);
  assert.equal(calls, 0);
});

test("logout during request body reading prevents account edits", async (t) => {
  const { controller, first, session, sessions, accounts } = controllerEnvironment(t);
  const request = Readable.from((async function* () {
    sessions.revoke(requestFor(session));
    yield Buffer.from(JSON.stringify({ cloudflareName: "Unauthorized edit" }));
  })());
  request.headers = requestFor(session).headers;
  await assert.rejects(controller.update({ request, params: { accountId: first.id } }), (error) => error.statusCode === 401);
  assert.equal(accounts.findAccount(first.id).name, "First");
});

test("logout while a connection test is pending prevents a success response", async (t) => {
  let complete;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const { controller, first, session, sessions } = controllerEnvironment(t, async () => {
    signalStarted();
    return new Promise((resolve) => { complete = resolve; });
  });
  const pending = controller.test({ request: requestFor(session), params: { accountId: first.id } });
  await started;
  sessions.revoke(requestFor(session));
  complete(Response.json({ success: true, result: [] }));
  await assert.rejects(pending, (error) => error.statusCode === 401);
});
