import { test } from "node:test";
import assert from "node:assert/strict";
import { state, resetSessionState } from "../public/js/state.js";
import { renderShell } from "../public/js/views/shell-view.js";
import { createActions } from "../public/js/actions.js";

function ui(t) {
  const previous = { document: global.document, FormData: global.FormData, fetch: global.fetch, window: global.window, location: global.location, history: global.history };
  const app = { innerHTML: "" };
  const fields = { cloudflareName: { value: "Renamed" }, cfEmail: { value: "edited@example.com" }, cfApiKey: { value: "" } };
  const form = { querySelector(selector) { return fields[selector.match(/name="([^"]+)"/)?.[1]] || null; } };
  global.document = { querySelector(selector) { return selector === "#app" ? app : form; } };
  global.FormData = class { get(name) { return fields[name]?.value || ""; } };
  global.window = { confirm: () => true };
  global.location = { pathname: "/" }; global.history = { replaceState() {} };
  resetSessionState();
  state.activeCloudflareAccountId = "cf-a";
  state.cloudflareAccounts = [{ id: "cf-a", name: "Old", email: "ed***@example.com" }];
  state.accountManagerOpen = true;
  state.accountManagerEdit = { id: "cf-a", name: "Old", email: "edited@example.com", hasApiKey: true };
  t.after(() => { Object.assign(global, previous); resetSessionState(); });
  return { app, fields };
}
const response = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

test("account management renders editable email and a blank replacement key field", (t) => {
  const { app } = ui(t);
  renderShell("test");
  assert.match(app.innerHTML, /id="cloudflare-account-manage"/);
  assert.match(app.innerHTML, /aria-label="Cloudflare 账号管理"/);
  assert.match(app.innerHTML, /name="cfEmail"[^>]*value="edited@example.com"/);
  assert.match(app.innerHTML, /留空保留/);
});

test("account edits send the blank key without overwriting it in the browser", async (t) => {
  ui(t);
  const module = await import("../public/js/actions/account-management-actions.js").catch(() => null);
  assert.ok(module?.createAccountManagementActions, "account management actions are available");
  const requests = [];
  global.fetch = async (url, options = {}) => { requests.push({ url, options }); return response({ authenticated: true, hasCredentials: true,
    activeCloudflareAccount: { id: "cf-a", name: "Renamed", email: "ed***@example.com" }, accounts: [{ id: "cf-a", name: "Renamed" }], csrfToken: "csrf" }); };
  const actions = module.createAccountManagementActions({ renderApp() {}, async loadZones() {} });
  await actions.saveManagedCloudflareAccount({ preventDefault() {} });
  assert.equal(requests[0].options.method, "PATCH");
  assert.equal(JSON.parse(requests[0].options.body).cfApiKey, "");
  assert.equal(state.cloudflareAccounts[0].name, "Renamed");
  assert.equal(state.accountManagerEdit, null);
  assert.equal(state.accountManagerOpen, true);
});

test("navigation during an account detail request releases and closes the old dialog", async (t) => {
  ui(t);
  state.mainSection = "workers";
  state.accountManagerBusy = true;
  await createActions({ renderApp() {} }).openMainSection("domain");
  assert.equal(state.accountManagerBusy, false);
  assert.equal(state.accountManagerOpen, false);
  assert.equal(state.accountManagerEdit, null);
});

for (const last of [false, true]) test(`account deletion reconciles session selection after navigation (${last ? "last" : "remaining"} account)`, async (t) => {
  ui(t);
  state.connected = true; state.sessionAuthenticated = true;
  let finish;
  global.fetch = () => new Promise((resolve) => { finish = resolve; });
  const { createAccountManagementActions } = await import("../public/js/actions/account-management-actions.js");
  const actions = createAccountManagementActions({ renderApp() {}, async loadZones() {} });
  const pending = actions.deleteManagedCloudflareAccount("cf-a");
  await createActions({ renderApp() {} }).openMainSection("speed");
  finish(response({ authenticated: true, hasCredentials: !last, activeCloudflareAccount: last ? null : { id: "cf-b" },
    accounts: last ? [] : [{ id: "cf-b", name: "Remaining" }], setupRequired: last,
    setupState: { panelUserRequired: false, cloudflareAccountRequired: last } }));
  await pending;
  assert.equal(state.activeCloudflareAccountId, last ? "" : "cf-b");
  assert.equal(state.connected, !last);
  assert.equal(state.accountManagerOpen, false);
});

test("an old nonactive account save cannot clear a reopened manager's pending edit", async (t) => {
  ui(t);
  state.accountManagerEdit.id = "cf-b";
  const requests = [];
  global.fetch = (url, options = {}) => new Promise((resolve) => requests.push({ url, options, resolve }));
  const { createAccountManagementActions } = await import("../public/js/actions/account-management-actions.js");
  const actions = createAccountManagementActions({ renderApp() {}, async loadZones() {} });
  const saving = actions.saveManagedCloudflareAccount({ preventDefault() {} });
  await createActions({ renderApp() {} }).openMainSection("speed");
  actions.openAccountManager();
  const editing = actions.editManagedCloudflareAccount("cf-a");
  requests[0].resolve(response({ authenticated: true, hasCredentials: true, activeCloudflareAccount: { id: "cf-a" }, accounts: [{ id: "cf-a" }, { id: "cf-b" }] }));
  await saving;
  assert.equal(state.accountManagerBusy, true);
  requests[1].resolve(response({ account: { id: "cf-a", name: "New edit", email: "a@example.com" } }));
  await editing;
  assert.equal(state.accountManagerEdit.name, "New edit");
});
