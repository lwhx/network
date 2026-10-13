import { test } from "node:test";
import assert from "node:assert/strict";
import { state } from "../public/js/state.js";
import { createAnalyticsActions } from "../public/js/actions/analytics-actions.js";
import { createWorkersActions } from "../public/js/actions/workers-actions.js";
import { createDeveloperResourcesActions } from "../public/js/actions/developer-resources-actions.js";
import { createAutomationActions } from "../public/js/actions/automation-actions.js";
import { createHistoryActions } from "../public/js/actions/history-actions.js";
import { createSpeedActions } from "../public/js/actions/speed-actions.js";
import { createZoneSettingsActions } from "../public/js/actions/zone-settings-actions.js";

function deferredFetch(t) {
  const previousFetch = global.fetch;
  const previousState = structuredClone(state);
  const requests = [];
  global.fetch = (url, options = {}) => new Promise((resolve, reject) => {
    requests.push({ url: String(url), options, reject, respond(payload, status = 200) {
      resolve(new Response(JSON.stringify(payload), {
        status, headers: { "Content-Type": "application/json" },
      }));
    } });
  });
  t.after(() => {
    global.fetch = previousFetch;
    Object.assign(state, previousState);
  });
  Object.assign(state, { activeCloudflareAccountId: "cf-a", view: "domains", mainSection: "domain" });
  return requests;
}

function formValues(t, values) {
  const previousDocument = global.document;
  const previousFormData = global.FormData;
  global.document = { querySelector() { return {}; } };
  global.FormData = class {
    get(key) { return values[key] || ""; }
  };
  t.after(() => {
    global.document = previousDocument;
    global.FormData = previousFormData;
  });
}

test("analytics ignores an old zone success and finally while the new zone is loading", async (t) => {
  const requests = deferredFetch(t);
  let renders = 0;
  const actions = createAnalyticsActions({ renderApp() { renders += 1; } });
  state.selectedZone = { id: "zone-a" };
  const older = actions.loadZoneAnalytics();
  state.selectedZone = { id: "zone-b" };
  const newer = actions.loadZoneAnalytics();
  const before = renders;
  requests[0].respond({ analytics: { zone: "a" } });
  await older;
  assert.equal(state.analytics, null);
  assert.equal(state.loadingAnalytics, true);
  assert.equal(renders, before);
  requests[1].respond({ analytics: { zone: "b" } });
  await newer;
  assert.deepEqual(state.analytics, { zone: "b" });
  assert.equal(state.loadingAnalytics, false);
});

test("analytics repeated reads keep the newest result when responses arrive reversed", async (t) => {
  const requests = deferredFetch(t);
  const actions = createAnalyticsActions({ renderApp() {} });
  state.selectedZone = { id: "zone-a" };
  const older = actions.loadZoneAnalytics("7d");
  const newer = actions.loadZoneAnalytics("30d");
  requests[1].respond({ analytics: { range: "30d" } });
  await newer;
  requests[0].respond({ analytics: { range: "7d" } });
  await older;
  assert.deepEqual(state.analytics, { range: "30d" });
});

test("analytics ignores stale errors after an account change", async (t) => {
  const requests = deferredFetch(t);
  let renders = 0;
  const actions = createAnalyticsActions({ renderApp() { renders += 1; } });
  state.selectedZone = { id: "zone-a" };
  const pending = actions.loadZoneAnalytics();
  state.activeCloudflareAccountId = "cf-b";
  state.analyticsError = "current account notice";
  state.loadingAnalytics = false;
  const before = renders;
  requests[0].respond({ error: "old account error" }, 500);
  await pending;
  assert.equal(state.analyticsError, "current account notice");
  assert.equal(renders, before);
});

test("worker detail switching keeps the new worker and script", async (t) => {
  const requests = deferredFetch(t);
  const actions = createWorkersActions({ renderApp() {} });
  state.mainSection = "workers";
  state.workersAccountId = "account-a";
  const older = actions.openEditWorker("older-worker");
  const newer = actions.openEditWorker("newer-worker");
  requests[1].respond({ worker: { worker: { name: "newer-worker" }, script: "new script" } });
  await newer;
  requests[0].respond({ worker: { worker: { name: "older-worker" }, script: "old script" } });
  await older;
  assert.equal(state.workersActiveDetail.worker.name, "newer-worker");
  assert.equal(state.workersScript, "new script");
});

test("closing worker detail prevents its pending error and finally from rendering", async (t) => {
  const requests = deferredFetch(t);
  let renders = 0;
  const actions = createWorkersActions({ renderApp() { renders += 1; } });
  state.mainSection = "workers";
  const pending = actions.openEditWorker("worker");
  actions.closeWorkersModal();
  const before = renders;
  requests[0].reject(new Error("old worker failure"));
  await pending;
  assert.equal(state.workersNotice, "");
  assert.equal(state.workersActiveDetail, null);
  assert.equal(renders, before);
});

test("developer resource details ignore an old resource response", async (t) => {
  const requests = deferredFetch(t);
  const actions = createDeveloperResourcesActions({ renderApp() {} });
  state.mainSection = "d1";
  state.developerResourceAccountId = "account-a";
  const older = actions.openDeveloperResourceDetail("older-db");
  const newer = actions.openDeveloperResourceDetail("newer-db");
  requests[1].respond({ resource: { id: "newer-db" } });
  await newer;
  requests[0].respond({ resource: { id: "older-db" } });
  await older;
  assert.deepEqual(state.developerResourceDetail, { id: "newer-db" });
});

test("developer resource detail errors are ignored after a resource type switch", async (t) => {
  const requests = deferredFetch(t);
  let renders = 0;
  const actions = createDeveloperResourcesActions({ renderApp() { renders += 1; } });
  state.mainSection = "d1";
  const pending = actions.openDeveloperResourceDetail("db");
  state.mainSection = "r2";
  state.developerResourceDetailNotice = "new resource notice";
  const before = renders;
  requests[0].reject(new Error("old database failure"));
  await pending;
  assert.equal(state.developerResourceDetailNotice, "new resource notice");
  assert.equal(renders, before);
});

test("workers initial account selection finishes loading and renders its accepted list", async (t) => {
  const requests = deferredFetch(t);
  let renders = 0;
  const actions = createWorkersActions({ renderApp() { renders += 1; } });
  Object.assign(state, { mainSection: "workers", workersAccountId: "", workersAccounts: [] });
  const pending = actions.loadWorkers();
  requests[0].respond({ workers: { accountId: "selected-account", workers: [{ name: "worker" }] } });
  await pending;
  assert.equal(state.workersAccountId, "selected-account");
  assert.equal(state.workersLoading, false);
  assert.equal(renders, 2);
});

test("developer initial account selection finishes loading and renders its accepted list", async (t) => {
  const requests = deferredFetch(t);
  let renders = 0;
  const actions = createDeveloperResourcesActions({ renderApp() { renders += 1; } });
  Object.assign(state, { mainSection: "d1", developerResourceAccountId: "", developerResourceAccounts: [] });
  const pending = actions.loadDeveloperResources();
  requests[0].respond({ resources: { type: "d1", accountId: "selected-account", items: [{ id: "db" }] } });
  await pending;
  assert.equal(state.developerResourceAccountId, "selected-account");
  assert.equal(state.developerResourceLoading, false);
  assert.equal(renders, 2);
});

test("developer list loading preserves a detail opened after the list request began", async (t) => {
  const requests = deferredFetch(t);
  const actions = createDeveloperResourcesActions({ renderApp() {} });
  Object.assign(state, { mainSection: "d1", developerResourceAccountId: "account" });
  const list = actions.loadDeveloperResources();
  const detail = actions.openDeveloperResourceDetail("db");
  requests[1].respond({ resource: { id: "db" } });
  await detail;
  requests[0].respond({ resources: { type: "d1", accountId: "account", items: [{ id: "db" }] } });
  await list;
  assert.equal(state.developerResourceActiveId, "db");
  assert.deepEqual(state.developerResourceDetail, { id: "db" });
});

test("automation repeated loads keep the latest result", async (t) => {
  const requests = deferredFetch(t);
  const actions = createAutomationActions({ renderApp() {} });
  Object.assign(state, { mainSection: "automation", automationZoneId: "zone" });
  const older = actions.loadAutomationState();
  const newer = actions.loadAutomationState();
  requests[1].respond({ automation: { version: "new" } });
  await newer;
  requests[0].respond({ automation: { version: "old" } });
  await older;
  assert.deepEqual(state.automationState, { version: "new" });
});

test("history ignores a pending response after changing its module filter", async (t) => {
  const requests = deferredFetch(t);
  const actions = createHistoryActions({ renderApp() {} });
  Object.assign(state, { mainSection: "history", operationHistoryModule: "dns" });
  const older = actions.loadOperationHistory();
  const newer = actions.changeOperationHistoryFilter({ target: { dataset: { historyFilter: "module" }, value: "workers" } });
  requests[1].respond({ history: { entries: [{ id: "current" }] } });
  await newer;
  requests[0].respond({ history: { entries: [{ id: "stale" }] } });
  await older;
  assert.deepEqual(state.operationHistory, [{ id: "current" }]);
});

test("zone setting responses and errors are ignored after switching zones", async (t) => {
  const requests = deferredFetch(t);
  let renders = 0;
  const actions = createZoneSettingsActions({ renderApp() { renders += 1; } });
  Object.assign(state, { selectedZone: { id: "older-zone" }, zoneSection: "ssl" });
  const pending = actions.loadSslSettings();
  state.selectedZone = { id: "newer-zone" };
  state.sslSettings = { ssl: "strict" };
  state.loadingSslSettings = false;
  const before = renders;
  requests[0].respond({ ssl: { settings: { ssl: "off" } } });
  await pending;
  assert.deepEqual(state.sslSettings, { ssl: "strict" });
  assert.equal(renders, before);

  const error = actions.loadCertificates();
  state.selectedZone = { id: "third-zone" };
  state.certificateError = "current notice";
  requests[1].reject(new Error("stale certificate error"));
  await error;
  assert.equal(state.certificateError, "current notice");
});

test("speed domain refreshes keep the newest list", async (t) => {
  const requests = deferredFetch(t);
  const actions = createSpeedActions({ renderApp() {} });
  Object.assign(state, { mainSection: "speed", speedDomainsOpen: true, zones: [{ id: "zone", name: "example.com" }] });
  const older = actions.refreshSpeedDomainsDialog();
  const newer = actions.refreshSpeedDomainsDialog();
  requests[1].respond({ speed: { domains: [{ id: "new", accessDomain: "new.example.com" }] } });
  await newer;
  requests[0].respond({ speed: { domains: [{ id: "old", accessDomain: "old.example.com" }] } });
  await older;
  assert.equal(state.speedAcceleratedDomains[0].id, "new");
});

test("KV value reads keep the selected key and value when requests resolve reversed", async (t) => {
  const requests = deferredFetch(t);
  const actions = createDeveloperResourcesActions({ renderApp() {} });
  Object.assign(state, { mainSection: "kv", developerResourceActiveId: "namespace" });
  const older = actions.readKvValue("old-key");
  const newer = actions.readKvValue("new-key");
  requests[1].respond({ value: { value: "new-value" } });
  await newer;
  requests[0].respond({ value: { value: "old-value" } });
  await older;
  assert.equal(state.developerResourceKvKey, "new-key");
  assert.equal(state.developerResourceKvValue, "new-value");
});

test("a worker mutation cannot update or reload a newly selected worker", async (t) => {
  const requests = deferredFetch(t);
  const actions = createWorkersActions({ renderApp() {} });
  Object.assign(state, {
    mainSection: "workers", workersModal: "edit", workersActiveName: "old-worker",
    workersActiveDetail: { worker: { name: "old-worker" }, subdomain: { enabled: true } },
  });
  const pending = actions.toggleWorkerSubdomain({ currentTarget: { checked: false } });
  const newer = actions.openEditWorker("new-worker");
  requests[1].respond({ worker: { worker: { name: "new-worker" }, script: "new", subdomain: { enabled: true } } });
  await newer;
  requests[0].respond({ subdomain: { enabled: false } });
  await pending;
  assert.equal(state.workersActiveDetail.worker.name, "new-worker");
  assert.equal(state.workersActiveDetail.subdomain.enabled, true);
  assert.equal(state.workersNotice, "");
  assert.equal(requests.length, 2);
});

test("a Pages save cannot fetch detail for a newly selected resource", async (t) => {
  const requests = deferredFetch(t);
  const previousDocument = global.document;
  global.document = { querySelector() { return null; } };
  t.after(() => { global.document = previousDocument; });
  const actions = createDeveloperResourcesActions({ renderApp() {} });
  Object.assign(state, { mainSection: "pages", developerResourceActiveId: "old-project" });
  const pending = actions.submitPagesBuildConfig({ preventDefault() {} });
  const newer = actions.openDeveloperResourceDetail("new-project");
  requests[1].respond({ resource: { id: "new-project" } });
  await newer;
  requests[0].respond({ resource: { id: "old-project" } });
  await pending;
  assert.deepEqual(state.developerResourceDetail, { id: "new-project" });
  assert.equal(state.developerResourceDetailNotice, "");
  assert.equal(requests.length, 2);
});

test("history clear followup cannot overwrite a subsequent history read", async (t) => {
  const requests = deferredFetch(t);
  const actions = createHistoryActions({ renderApp() {} });
  state.mainSection = "history";
  const clearing = actions.clearOperationHistory();
  requests[0].respond({ history: { deleted: 2 } });
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  const newer = actions.loadOperationHistory();
  requests[2].respond({ history: { entries: [{ id: "new" }] } });
  await newer;
  requests[1].respond({ history: { entries: [{ id: "old" }] } });
  await clearing;
  assert.deepEqual(state.operationHistory, [{ id: "new" }]);
  assert.equal(state.operationHistoryNotice, "");
});

test("worker mutations remain stale after closing and reopening the same worker", async (t) => {
  const requests = deferredFetch(t);
  const actions = createWorkersActions({ renderApp() {} });
  Object.assign(state, { mainSection: "workers", workersModal: "edit", workersActiveName: "worker" });
  const oldMutation = actions.toggleWorkerSubdomain({ currentTarget: { checked: false } });
  actions.closeWorkersModal();
  const reopened = actions.openEditWorker("worker");
  requests[1].respond({ worker: { worker: { name: "worker" }, script: "new", subdomain: { enabled: true } } });
  await reopened;
  requests[0].respond({ subdomain: { enabled: false } });
  await oldMutation;
  assert.equal(state.workersActiveDetail.subdomain.enabled, true);
  assert.equal(state.workersNotice, "");
});

test("speed deployment ignores progress and success after changing accounts", async (t) => {
  const requests = deferredFetch(t);
  const previousWindow = global.window;
  const timers = [];
  global.window = { setTimeout(callback) { timers.push(callback); return timers.length; }, clearTimeout() {} };
  t.after(() => { global.window = previousWindow; });
  let renders = 0;
  const actions = createSpeedActions({ renderApp() { renders += 1; } });
  Object.assign(state, {
    mainSection: "speed", speedStep: "deploy", zones: [{ id: "zone", name: "example.com" }],
    speedForm: { accessDomain: "app.example.com", targetDomain: "origin.example.net", cacheTtl: "300", optimizedDomain: "saas.example.net" },
  });
  const pending = actions.startSpeedDeploy();
  state.activeCloudflareAccountId = "cf-b";
  state.speedStep = "domains";
  state.speedDeploying = false;
  state.speedProgress = 0;
  state.speedAcceleratedDomains = [];
  const before = renders;
  for (const callback of timers) callback();
  requests[0].respond({ speed: {} });
  await pending;
  assert.equal(state.speedProgress, 0);
  assert.equal(state.speedStep, "domains");
  assert.deepEqual(state.speedAcceleratedDomains, []);
  assert.equal(renders, before);
});

test("developer create completion cannot close a reopened create modal", async (t) => {
  const requests = deferredFetch(t);
  formValues(t, { name: "old-db" });
  let renders = 0;
  const actions = createDeveloperResourcesActions({ renderApp() { renders += 1; } });
  Object.assign(state, { mainSection: "d1", developerResourceAccountId: "account" });
  actions.openDeveloperResourceCreateModal();
  const pending = actions.submitDeveloperResource({ preventDefault() {} });
  actions.closeDeveloperResourceModal();
  actions.openDeveloperResourceCreateModal();
  state.developerResourceNotice = "new draft notice";
  const before = renders;
  requests[0].respond({ resource: { id: "old-db" } });
  await new Promise(setImmediate);
  // Settle an unexpected old-request reload so a regression fails assertions, not by hanging.
  if (requests[1]) requests[1].respond({ resources: { type: "d1", accountId: "account", items: [] } });
  await pending;
  assert.equal(state.developerResourceModal, "create");
  assert.equal(state.developerResourceNotice, "new draft notice");
  assert.equal(requests.length, 1);
  assert.equal(renders, before);
});

test("developer create errors and finally cannot modify a reopened modal's pending save", async (t) => {
  const requests = deferredFetch(t);
  const values = { name: "old-db" };
  formValues(t, values);
  let renders = 0;
  const actions = createDeveloperResourcesActions({ renderApp() { renders += 1; } });
  Object.assign(state, { mainSection: "d1", developerResourceAccountId: "account" });
  actions.openDeveloperResourceCreateModal();
  const older = actions.submitDeveloperResource({ preventDefault() {} });
  actions.closeDeveloperResourceModal();
  actions.openDeveloperResourceCreateModal();
  values.name = "new-db";
  const newer = actions.submitDeveloperResource({ preventDefault() {} });
  const before = renders;
  requests[0].reject(new Error("old create failed"));
  await older;
  const savingAfterOldError = state.developerResourceSaving;
  const noticeAfterOldError = state.developerResourceNotice;
  const rendersAfterOldError = renders;
  requests[1].reject(new Error("new create failed"));
  await newer;
  assert.equal(savingAfterOldError, true);
  assert.equal(noticeAfterOldError, "");
  assert.equal(rendersAfterOldError, before);
});

test("worker create completion cannot close or clear a reopened create draft", async (t) => {
  const requests = deferredFetch(t);
  formValues(t, { name: "old-worker", script: "old script" });
  let renders = 0;
  const actions = createWorkersActions({ renderApp() { renders += 1; } });
  Object.assign(state, { mainSection: "workers", workersAccountId: "account" });
  actions.openCreateWorkerModal();
  const pending = actions.submitCreateWorker({ preventDefault() {} });
  actions.closeWorkersModal();
  actions.openCreateWorkerModal();
  state.workersScript = "new draft script";
  state.workersNotice = "new draft notice";
  const before = renders;
  requests[0].respond({ worker: { worker: { name: "old-worker" } } });
  await new Promise(setImmediate);
  if (requests[1]) requests[1].respond({ workers: { accountId: "account", workers: [] } });
  await pending;
  assert.equal(state.workersModal, "create");
  assert.equal(state.workersScript, "new draft script");
  assert.equal(state.workersNotice, "new draft notice");
  assert.equal(requests.length, 1);
  assert.equal(renders, before);
});

test("developer delete completion cannot close a reopened confirmation for the same resource", async (t) => {
  const requests = deferredFetch(t);
  const actions = createDeveloperResourcesActions({ renderApp() {} });
  Object.assign(state, { mainSection: "d1", developerResourceAccountId: "account" });
  actions.requestDeleteDeveloperResource("db", "Database");
  state.developerResourceDeleteConfirm = "Database";
  const pending = actions.confirmDeleteDeveloperResource();
  actions.closeDeveloperResourceModal();
  actions.requestDeleteDeveloperResource("db", "Database");
  state.developerResourceDeleteConfirm = "new confirmation draft";
  requests[0].respond({ deleted: true });
  await new Promise(setImmediate);
  if (requests[1]) requests[1].respond({ resources: { type: "d1", accountId: "account", items: [] } });
  await pending;
  assert.equal(state.developerResourceModal, "delete");
  assert.equal(state.developerResourceDeleteConfirm, "new confirmation draft");
  assert.equal(requests.length, 1);
});
