import { test } from "node:test";
import assert from "node:assert/strict";
import { state, resetSessionState, resetCloudflareAccountData } from "../public/js/state.js";
import { createDnsActions } from "../public/js/actions/dns-actions.js";
import { createDomainActions } from "../public/js/actions/domain-actions.js";
import { createActions } from "../public/js/actions.js";
import { createSessionActions } from "../public/js/actions/session-actions.js";

function environment(t) {
  resetSessionState();
  state.activeCloudflareAccountId = "account-a";
  state.selectedZone = { id: "a".repeat(32), name: "a.example" };
  const previous = global.fetch;
  const requests = [];
  global.fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  t.after(() => { global.fetch = previous; resetSessionState(); });
  return requests;
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("a late DNS response cannot replace the current zone's records or loading state", async (t) => {
  const requests = environment(t);
  const actions = createDnsActions({ renderApp() {} });
  const first = actions.loadDnsRecords();
  state.selectedZone = { id: "b".repeat(32), name: "b.example" };
  const second = actions.loadDnsRecords();
  requests[0].resolve(response({ records: [{ id: "old", name: "a.example" }] }));
  await first;
  assert.deepEqual(state.dnsRecords, []);
  assert.equal(state.loadingDns, true);
  requests[1].resolve(response({ records: [{ id: "new", name: "b.example" }] }));
  await second;
  assert.equal(state.dnsRecords[0].id, "new");
});

test("only the newest same-zone refresh can update DNS data", async (t) => {
  const requests = environment(t);
  const actions = createDnsActions({ renderApp() {} });
  const first = actions.loadDnsRecords();
  const second = actions.loadDnsRecords();
  requests[1].resolve(response({ records: [{ id: "new" }] }));
  await second;
  requests[0].resolve(response({ records: [{ id: "old" }] }));
  await first;
  assert.equal(state.dnsRecords[0].id, "new");
});

test("an old account's domain response is ignored even after switching away and back", async (t) => {
  const requests = environment(t);
  const previous = global.location;
  global.location = { hash: "" };
  t.after(() => { global.location = previous; });
  const actions = createDomainActions({ renderApp() {}, async loadZoneSectionData() {}, showNotice() {} });
  const first = actions.loadZones();
  resetCloudflareAccountData();
  state.activeCloudflareAccountId = "account-b";
  resetCloudflareAccountData();
  state.activeCloudflareAccountId = "account-a";
  requests[0].resolve(response({ zones: [{ id: "old" }] }));
  await first;
  assert.deepEqual(state.zones, []);
});

test("late errors from an old zone do not appear on the current zone", async (t) => {
  const requests = environment(t);
  const actions = createDnsActions({ renderApp() {} });
  const first = actions.loadDnsRecords();
  state.selectedZone = { id: "b".repeat(32) };
  requests[0].reject(new Error("old zone failed"));
  await first;
  assert.equal(state.dnsError, "");
});

test("navigation releases obsolete loading and saving flags before returning to a section", async (t) => {
  environment(t);
  const previous = { location: global.location, history: global.history };
  global.location = { hash: "", pathname: "/" }; global.history = { replaceState() {} };
  t.after(() => Object.assign(global, previous));
  state.mainSection = "workers";
  state.workersLoading = true;
  state.savingDns = true;
  const actions = createActions({ renderApp() {} });
  await actions.openMainSection("domain");
  assert.equal(state.workersLoading, false);
  assert.equal(state.savingDns, false);
});

test("navigation preserves the account-wide zone list still loading after login", async (t) => {
  const requests = environment(t);
  const previous = { location: global.location, history: global.history };
  global.location = { hash: "", pathname: "/" }; global.history = { replaceState() {} };
  t.after(() => Object.assign(global, previous));
  const actions = createActions({ renderApp() {} });
  const first = actions.loadZones();
  await actions.openMainSection("speed");
  requests[0].resolve(response({ zones: [{ id: "a".repeat(32), name: "loaded.example" }] }));
  await first;
  await actions.openMainSection("domain");
  assert.equal(state.zones[0]?.name, "loaded.example");
  assert.equal(state.loadingZones, false);
});

for (const outcome of ["success", "failure"]) test(`an old account's domain creation ${outcome} cannot alter the new account's page`, async (t) => {
  const requests = environment(t);
  const previous = global.document;
  global.document = { querySelector: () => ({ value: "created.example.com" }) };
  t.after(() => { global.document = previous; });
  const actions = createDomainActions({ renderApp() {}, async loadZoneSectionData() {}, showNotice() {} });
  const pending = actions.addDomain({ preventDefault() {} });
  resetCloudflareAccountData();
  state.activeCloudflareAccountId = "account-b";
  state.domainDraft = "new-account.example.com";
  state.notice = "new-account notice";
  state.addingDomain = true;
  if (outcome === "failure") requests[0].reject(new Error("old-account failure"));
  else requests[0].resolve(response({ zone: { name: "created.example.com" } }));
  await new Promise((resolve) => setImmediate(resolve));
  // Settle any incorrect followup GET so the unfixed implementation can finish.
  for (const request of requests.slice(1)) request.resolve(response({ zones: [] }));
  await pending;
  assert.equal(state.notice, "new-account notice");
  assert.equal(state.domainDraft, "new-account.example.com");
  assert.equal(state.addingDomain, true);
  assert.equal(requests.length, 1);
});

test("failed account switching restores reads instead of leaving the old account busy", async (t) => {
  environment(t);
  const previous = { location: global.location, history: global.history };
  global.location = { hash: `#/zones/${state.selectedZone.id}/dns`, pathname: "/" }; global.history = { replaceState() {} };
  t.after(() => Object.assign(global, previous));
  let finishOld; let dnsReads = 0;
  global.fetch = async (url) => {
    if (url.endsWith("/select")) return response({ error: "switch failed" }, 500);
    if (url === "/api/session/status") return response({ authenticated: true, hasCredentials: true, activeCloudflareAccount: { id: "account-a" }, accounts: [] });
    if (url === "/api/zones") return response({ zones: [{ id: "a".repeat(32), name: "old-account.example" }] });
    if (++dnsReads === 1) return new Promise((resolve) => { finishOld = resolve; });
    return response({ records: [{ id: "fresh" }] });
  };
  const actions = createActions({ renderApp() {} });
  const old = actions.loadDnsRecords();
  await actions.changeCloudflareAccount({ target: { value: "account-b" } });
  finishOld(response({ records: [{ id: "stale" }] }));
  await old;
  assert.equal(state.loadingDns, false);
  assert.equal(state.dnsRecords[0]?.id, "fresh");
  assert.equal(state.activeCloudflareAccountId, "account-a");
  assert.equal(state.sessionError, "switch failed");
});

test("a switch response arriving after logout cannot restore the signed-in UI", async (t) => {
  environment(t);
  const previous = { location: global.location, history: global.history };
  global.location = { hash: "", pathname: "/" }; global.history = { replaceState() {} };
  t.after(() => Object.assign(global, previous));
  state.connected = true; state.sessionAuthenticated = true;
  let finishSwitch;
  global.fetch = async (url) => url.endsWith("/select") ? new Promise((resolve) => { finishSwitch = resolve; }) :
    response(url.endsWith("/logout") ? { ok: true } : { authenticated: false, hasCredentials: false, loginRequired: true });
  const actions = createSessionActions({ renderApp() {}, async loadZones() {} });
  const switching = actions.changeCloudflareAccount({ target: { value: "account-b" } });
  await actions.logoutSession();
  finishSwitch(response({ authenticated: true, hasCredentials: true, activeCloudflareAccount: { id: "account-b" }, accounts: [] }));
  await switching;
  assert.equal(state.connected, false);
  assert.equal(state.sessionAuthenticated, false);
});

test("a lost switch response reconciles server account selection before loading its resources", async (t) => {
  environment(t);
  const previous = { location: global.location, history: global.history };
  global.location = { hash: "", pathname: "/" }; global.history = { replaceState() {} };
  t.after(() => Object.assign(global, previous));
  const requests = [];
  global.fetch = async (url) => {
    requests.push(url);
    if (url.endsWith("/select")) throw new Error("response lost");
    return response({ authenticated: true, hasCredentials: true, activeCloudflareAccount: { id: "account-b" }, accounts: [] });
  };
  let resourceAccount;
  const actions = createSessionActions({ renderApp() {}, async loadZones() { resourceAccount = state.activeCloudflareAccountId; } });
  await actions.changeCloudflareAccount({ target: { value: "account-b" } });
  assert.ok(requests.includes("/api/session/status"));
  assert.equal(resourceAccount, "account-b");
  assert.equal(state.connected, true);
});
