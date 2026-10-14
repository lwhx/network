import assert from "node:assert/strict";
import { test } from "node:test";
import { DeveloperResourcesService } from "../src/services/cloudflare/developer-resources-service.js";

const accountId = "a".repeat(32);
const namespaceId = "b".repeat(32);
function environment(payload) {
  const calls = [];
  const service = new DeveloperResourcesService({ cloudflareClient: { async get(path, query) {
    calls.push({ path, query });
    if (path === "accounts") return { result: [{ id: accountId, name: "Fixture" }], result_info: { total_pages: 1 } };
    if (path.endsWith(`/namespaces/${namespaceId}`)) return { result: { id: namespaceId, title: "Cache" } };
    return payload;
  } } });
  return { service, calls };
}

test("KV pages retain opaque cursor, prefix and requested page size", async () => {
  const { service, calls } = environment({ result: [{ name: "配置:一", metadata: { version: 2 } }], result_info: { cursor: " next+/= " } });
  const page = await service.listKvKeysPage(accountId, namespaceId, { prefix: "配置:", cursor: " previous+/= ", limit: 100 });
  assert.equal(page.accountId, accountId);
  assert.equal(page.namespaceId, namespaceId);
  assert.equal(page.prefix, "配置:");
  assert.equal(page.limit, 100);
  assert.equal(page.cursor, " next+/= ");
  assert.equal(page.hasMore, true);
  assert.equal(page.keys[0].name, "配置:一");
  assert.deepEqual(calls[1], { path: `accounts/${accountId}/storage/kv/namespaces/${namespaceId}/keys`,
    query: { prefix: "配置:", cursor: " previous+/= ", limit: 100 } });
});

test("an empty KV page with a cursor can still load another page", async () => {
  const { service } = environment({ result: [], result_info: { cursor: "continue" } });
  const page = await service.listKvKeysPage(accountId, namespaceId);
  assert.deepEqual(page.keys, []);
  assert.equal(page.hasMore, true);
  assert.equal(page.limit, 50);
});

test("terminal KV pages do not guess pagination from the result count", async () => {
  const { service } = environment({ result: Array.from({ length: 50 }, (_, i) => ({ name: `key-${i}` })), result_info: { count: 50 } });
  const page = await service.listKvKeysPage(accountId, namespaceId);
  assert.equal(page.keys.length, 50);
  assert.equal(page.hasMore, false);
  assert.equal(page.cursor, "");
});

test("invalid KV pagination input fails before any Cloudflare reads", async () => {
  for (const options of [{ limit: 9 }, { limit: 1001 }, { limit: 20.5 }, { limit: "bad" },
    { prefix: "中".repeat(171) }, { cursor: "x".repeat(4097) }, { cursor: {} }, { prefix: [] }]) {
    const { service, calls } = environment({ result: [] });
    await assert.rejects(service.listKvKeysPage(accountId, namespaceId, options), error => error.statusCode === 400);
    assert.equal(calls.length, 0);
  }
});

test("KV page access checks that the requested account belongs to current credentials", async () => {
  const { service, calls } = environment({ result: [] });
  await assert.rejects(service.listKvKeysPage("c".repeat(32), namespaceId), error => error.statusCode === 404);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "accounts");
});

test("malformed KV page responses fail instead of looking like an empty namespace", async () => {
  for (const payload of [{ result: {} }, { result: [null] }, { result: [{}] },
    { result: [{ name: 3 }] }, { result: [], result_info: { cursor: {} } }]) {
    const { service } = environment(payload);
    await assert.rejects(service.listKvKeysPage(accountId, namespaceId), error => error.statusCode === 502);
  }
});

test("KV does not return a repeated cursor as another page", async () => {
  const { service } = environment({ result: [{ name: "key" }], result_info: { cursor: "same" } });
  await assert.rejects(service.listKvKeysPage(accountId, namespaceId, { cursor: "same" }), error => error.statusCode === 502);
});

test("KV detail retains the legacy keys array and exposes first-page pagination", async () => {
  const { service } = environment({ result: [{ name: "first" }], result_info: { cursor: "next" } });
  const detail = await service.getDetail("kv", accountId, namespaceId);
  assert.equal(detail.extras.keys[0].name, "first");
  assert.deepEqual(detail.extras.keyPage, { cursor: "next", hasMore: true, prefix: "", limit: 50 });
});

test("legacy KV key listing remains an array while refusing malformed results", async () => {
  const valid = environment({ result: [{ name: "key" }] });
  assert.deepEqual((await valid.service.listKvKeys(accountId, namespaceId)).map(key => key.name), ["key"]);
  const invalid = environment({ result: {} });
  await assert.rejects(invalid.service.listKvKeys(accountId, namespaceId), error => error.statusCode === 502);
});
