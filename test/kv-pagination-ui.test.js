import assert from "node:assert/strict";
import { test } from "node:test";
import { state } from "../public/js/state.js";
import { createDeveloperResourcesActions } from "../public/js/actions/developer-resources-actions.js";

function environment(t) {
  const previousState = structuredClone(state), previousFetch = global.fetch;
  const requests = [];
  global.fetch = (url, options = {}) => new Promise(resolve => requests.push({ url: String(url), options,
    respond(page, status = 200) { resolve(Response.json(status === 200 ? { page } : { error: page }, { status })); },
    detail(resource) { resolve(Response.json({ resource })); },
    value(value) { resolve(Response.json({ value: { value } })); },
    saved() { resolve(Response.json({ result: {} })); } }));
  t.after(() => { global.fetch = previousFetch; Object.assign(state, previousState); });
  Object.assign(state, { view: "domains", mainSection: "kv", activeCloudflareAccountId: "local-a",
    developerResourceAccountId: "remote-a", developerResourceActiveId: "namespace-a",
    developerResourceDetail: { id: "namespace-a", accountId: "remote-a", type: "kv", extras: { keys: [{ name: "first" }] } },
    developerResourceKvPrefix: "", developerResourceKvPrefixDraft: "", developerResourceKvCursor: "c1",
    developerResourceKvHasMore: true, developerResourceKvSeenCursors: [], developerResourceKvKeysLoading: false,
    developerResourceKvKeysNotice: "", developerResourceKvKey: "editing", developerResourceKvValue: "draft" });
  const actions = createDeveloperResourcesActions({ renderApp() {} });
  const page = (keys, cursor = "", prefix = state.developerResourceKvPrefix) => ({
    accountId: state.developerResourceAccountId, namespaceId: state.developerResourceActiveId, prefix, limit: 50,
    keys: keys.map(name => ({ name })), cursor, hasMore: Boolean(cursor) });
  return { requests, actions, page };
}

test("KV load more appends unique keys and preserves the editor draft", async t => {
  const { requests, actions, page } = environment(t);
  const pending = actions.loadMoreKvKeys();
  assert.equal(new URL(requests[0].url, "http://panel").searchParams.get("cursor"), "c1");
  actions.syncKvEditor({ target: { name: "value", value: "changed while loading" } });
  requests[0].respond(page(["first", "second"], "c2"));
  await pending;
  assert.deepEqual(state.developerResourceDetail.extras.keys.map(key => key.name), ["first", "second"]);
  assert.equal(state.developerResourceKvValue, "changed while loading");
  assert.equal(state.developerResourceKvKey, "editing");
  assert.equal(state.developerResourceKvCursor, "c2");
});

test("KV prefix search resets pagination and rejects a late previous page", async t => {
  const { requests, actions, page } = environment(t);
  const older = actions.loadMoreKvKeys();
  actions.syncKvPrefix({ target: { value: "配置:" } });
  const newer = actions.filterKvKeys({ preventDefault() {} });
  assert.equal(new URL(requests[1].url, "http://panel").searchParams.get("prefix"), "配置:");
  assert.equal(new URL(requests[1].url, "http://panel").searchParams.has("cursor"), false);
  requests[1].respond(page(["配置:一"])); await newer;
  requests[0].respond(page(["late"], "old", "")); await older;
  assert.deepEqual(state.developerResourceDetail.extras.keys.map(key => key.name), ["配置:一"]);
  assert.equal(state.developerResourceKvHasMore, false);
  assert.equal(state.developerResourceKvKey, "editing");
});

test("KV page failures retain loaded keys and allow retrying the same cursor", async t => {
  const { requests, actions, page } = environment(t);
  const pending = actions.loadMoreKvKeys();
  requests[0].respond("temporarily unavailable", 503); await pending;
  assert.equal(state.developerResourceDetail.extras.keys[0].name, "first");
  assert.equal(state.developerResourceKvCursor, "c1");
  assert.equal(state.developerResourceKvHasMore, true);
  assert.equal(state.developerResourceKvKeysLoading, false);
  const retry = actions.loadMoreKvKeys(); requests[1].respond(page(["second"])); await retry;
  assert.equal(state.developerResourceDetail.extras.keys.length, 2);
});

test("KV repeated load clicks send only one page request", async t => {
  const { requests, actions, page } = environment(t);
  const pending = actions.loadMoreKvKeys();
  await actions.loadMoreKvKeys();
  assert.equal(requests.length, 1);
  requests[0].respond(page(["second"])); await pending;
});

test("KV loading ignores a response after switching local Cloudflare accounts", async t => {
  const { requests, actions, page } = environment(t);
  const pending = actions.loadMoreKvKeys();
  const stale = page(["wrong account"]);
  state.activeCloudflareAccountId = "local-b";
  state.developerResourceDetail = { extras: { keys: [{ name: "current" }] } };
  requests[0].respond(stale); await pending;
  assert.equal(state.developerResourceDetail.extras.keys[0].name, "current");
});

test("KV namespace close and reopen cannot accept a previous namespace page", async t => {
  const { requests, actions, page } = environment(t);
  const pending = actions.loadMoreKvKeys(), stale = page(["stale"]);
  actions.closeDeveloperResourceDetail();
  const opened = actions.openDeveloperResourceDetail("namespace-a");
  requests[1].detail({ id: "namespace-a", accountId: "remote-a", type: "kv", extras: { keys: [{ name: "new" }], keyPage: { cursor: "", hasMore: false } } });
  await opened;
  requests[0].respond(stale); await pending;
  assert.equal(state.developerResourceDetail.extras.keys[0].name, "new");
  assert.equal(state.developerResourceKvKey, "");
  assert.equal(state.developerResourceKvValue, "");
});

test("KV pagination stops a cursor cycle without removing existing keys", async t => {
  const { requests, actions, page } = environment(t);
  state.developerResourceKvSeenCursors = ["previous"];
  const pending = actions.loadMoreKvKeys();
  requests[0].respond(page(["duplicate page"], "previous")); await pending;
  assert.equal(state.developerResourceDetail.extras.keys[0].name, "first");
  assert.equal(state.developerResourceKvHasMore, false);
  assert.match(state.developerResourceKvKeysNotice, /游标/);
});

test("a failed KV read keeps the original editor key and value together", async t => {
  const { requests, actions } = environment(t);
  const pending = actions.readKvValue("missing-key");
  requests[0].respond("key not found", 404); await pending;
  assert.equal(state.developerResourceKvKey, "editing");
  assert.equal(state.developerResourceKvValue, "draft");
  assert.equal(state.developerResourceDetailLoading, false);
});

test("typing a draft while a KV value read is pending prevents its late overwrite", async t => {
  const { requests, actions } = environment(t);
  const pending = actions.readKvValue("first");
  actions.syncKvEditor({ target: { name: "value", value: "new draft" } });
  requests[0].value("remote value"); await pending;
  assert.equal(state.developerResourceKvValue, "new draft");
  assert.equal(state.developerResourceDetailLoading, false);
});

test("saving a KV value invalidates a previously pending read of the same key", async t => {
  const { requests, actions, page } = environment(t);
  const previousDocument = global.document, previousFormData = global.FormData;
  global.document = { querySelector() { return {}; } };
  global.FormData = class { get(field) { return field === "key" ? "editing" : "new saved value"; } };
  t.after(() => { global.document = previousDocument; global.FormData = previousFormData; });
  const reading = actions.readKvValue("editing");
  const saving = actions.submitKvValue({ preventDefault() {} });
  requests[1].saved();
  await new Promise(resolve => setImmediate(resolve));
  requests[2].respond(page(["editing"])); await saving;
  requests[0].value("old remote value"); await reading;
  assert.equal(state.developerResourceKvValue, "new saved value");
  assert.equal(state.developerResourceDetailNotice, "KV Value 已保存");
});

test("deleting a KV key invalidates its pending read without removing the draft", async t => {
  const { requests, actions, page } = environment(t);
  const previousWindow = global.window;
  global.window = { confirm() { return true; } };
  t.after(() => { global.window = previousWindow; });
  const reading = actions.readKvValue("editing");
  const deleting = actions.deleteKvValue("editing");
  requests[1].saved();
  await new Promise(resolve => setImmediate(resolve));
  requests[2].respond(page([])); await deleting;
  requests[0].value("deleted remote value"); await reading;
  assert.equal(state.developerResourceKvValue, "draft");
  assert.equal(state.developerResourceDetailNotice, "KV Key 已删除");
});

test("KV does not start another value read while a save is pending", async t => {
  const { requests, actions, page } = environment(t);
  const previousDocument = global.document, previousFormData = global.FormData;
  global.document = { querySelector() { return {}; } };
  global.FormData = class { get(field) { return field === "key" ? "editing" : "saved value"; } };
  t.after(() => { global.document = previousDocument; global.FormData = previousFormData; });
  const saving = actions.submitKvValue({ preventDefault() {} });
  const reading = actions.readKvValue("other");
  if (requests.length > 1) requests[1].value("other value");
  await reading;
  requests[0].saved();
  await new Promise(resolve => setImmediate(resolve));
  requests.at(-1).respond(page(["editing"])); await saving;
  assert.equal(requests.filter(request => request.url.includes("/values?")).length, 0);
  assert.equal(state.developerResourceKvValue, "saved value");
});

test("reopening the same KV namespace during a save releases the old busy state", async t => {
  const { requests, actions } = environment(t);
  const previousDocument = global.document, previousFormData = global.FormData;
  global.document = { querySelector() { return {}; } };
  global.FormData = class { get(field) { return field === "key" ? "editing" : "saved value"; } };
  t.after(() => { global.document = previousDocument; global.FormData = previousFormData; });
  const saving = actions.submitKvValue({ preventDefault() {} });
  const opening = actions.openDeveloperResourceDetail("namespace-a");
  requests[1].detail({ id: "namespace-a", accountId: "remote-a", type: "kv", extras: { keys: [] } });
  await opening;
  requests[0].saved(); await saving;
  assert.equal(state.developerResourceKvSaving, false);
  assert.equal(state.developerResourceKvValue, "saved value");
  assert.equal(requests.length, 2);
});

test("editing during a KV save preserves the newer draft and marks it unsaved", async t => {
  const { requests, actions, page } = environment(t);
  const previousDocument = global.document, previousFormData = global.FormData;
  global.document = { querySelector() { return {}; } };
  global.FormData = class { get(field) { return field === "key" ? "editing" : "submitted value"; } };
  t.after(() => { global.document = previousDocument; global.FormData = previousFormData; });
  const saving = actions.submitKvValue({ preventDefault() {} });
  actions.syncKvEditor({ target: { name: "value", value: "new unsaved draft" } });
  requests[0].saved();
  await new Promise(resolve => setImmediate(resolve));
  requests[1].respond(page(["editing"])); await saving;
  assert.equal(state.developerResourceKvValue, "new unsaved draft");
  assert.match(state.developerResourceDetailNotice, /未保存/);
});
