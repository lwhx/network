import assert from "node:assert/strict";
import { test } from "node:test";
import { readCloudflareList } from "../src/services/cloudflare/cloudflare-list-reader.js";

async function run(payloads, options = {}) {
  const calls = [];
  const client = { async get(path, query) { calls.push({ path, query }); return payloads[calls.length - 1]; } };
  const result = await readCloudflareList({ client, path: "items", perPage: 2, ...options });
  return { result, calls };
}

test("list reader follows full pages when pagination totals are absent", async () => {
  const { result, calls } = await run([{ result: [{ id: "a" }, { id: "b" }] }, { result: [{ id: "c" }] }]);
  assert.deepEqual(result.map(item => item.id), ["a", "b", "c"]);
  assert.deepEqual(calls.map(call => call.query.page), [1, 2]);
});

test("explicit terminal page metadata avoids an unnecessary request", async () => {
  const { calls } = await run([{ result: [{ id: "a" }, { id: "b" }], result_info: { total_pages: 1 } }]);
  assert.equal(calls.length, 1);
});

test("list reader keeps filters across every page and deduplicates by identity", async () => {
  const { result, calls } = await run([
    { result: [{ id: "a", value: 1 }, { id: "b" }], result_info: { total_pages: 2 } },
    { result: [{ id: "a", value: 2 }, { id: "c" }], result_info: { total_pages: 2 } },
  ], { query: { zone_id: "zone", order: "name" } });
  assert.deepEqual(result.map(item => item.id), ["a", "b", "c"]);
  assert.equal(result[0].value, 2);
  assert.equal(calls[1].query.zone_id, "zone");
  assert.equal(calls[1].query.order, "name");
});

test("a cursor list can advance through an empty page", async () => {
  const { result, calls } = await run([
    { result: { buckets: [] }, result_info: { cursor: "next" } },
    { result: { buckets: [{ name: "last" }] }, result_info: { cursor: "" } },
  ], { pagination: "cursor", keys: ["buckets"], identity: item => item.name });
  assert.equal(result[0].name, "last");
  assert.equal(calls[1].query.cursor, "next");
  assert.equal(calls[1].query.page, undefined);
});

test("malformed pagination and list items produce a clear HTTP502", async () => {
  for (const payload of [
    { result: {} }, { result: [null] }, { result: [[1]] },
    { result: [{ id: "a" }], result_info: { page: 2 } },
    { result: [], result_info: { total_count: -1 } },
    { result: [], result_info: { total_pages: 2.5 } },
    { result: [], result_info: { per_page: 0 } },
    { result: [], result_info: { total_count: "bad" } },
    { result: [], result_info: [] },
  ]) await assert.rejects(run([payload]), error => error.statusCode === 502);
});

test("cursor list rejects malformed opaque cursor values", async () => {
  for (const cursor of [{}, 42, "x".repeat(4097)]) {
    await assert.rejects(run([{ result: [], result_info: { cursor } }], { pagination: "cursor" }), error => error.statusCode === 502);
  }
});

test("reader enforces page and record limits without returning partial results", async () => {
  await assert.rejects(run([{ result: [{ id: "a" }], result_info: { total_pages: 3 } }], { maxPages: 2 }), error => error.statusCode === 502);
  await assert.rejects(run([{ result: [{ id: "a" }, { id: "b" }] }], { maxItems: 1 }), error => error.statusCode === 502);
  await assert.rejects(run([
    { result: [], result_info: { cursor: "one" } },
    { result: [], result_info: { cursor: "two" } },
  ], { pagination: "cursor", maxPages: 2 }), error => error.statusCode === 502);
});

test("contradictory pagination totals do not silently truncate a list", async () => {
  await assert.rejects(run([{ result: [{ id: "a" }], result_info: { per_page: 2, total_pages: 1, total_count: 5 } }]), error => error.statusCode === 502);
});

test("terminal pages must satisfy the promised unique record count", async () => {
  for (const [last, total] of [[[], 3], [[{ id: "b" }, { id: "c" }], 4]]) {
    await assert.rejects(run([
      { result: [{ id: "a" }, { id: "b" }], result_info: { page: 1, per_page: 2, total_count: total, total_pages: 2 } },
      { result: last, result_info: { page: 2, per_page: 2, total_count: total, total_pages: 2 } },
    ]), error => error.statusCode === 502);
  }
  await assert.rejects(run([
    { result: [{ id: "a" }, { id: "b" }], result_info: { total_pages: 2 } },
    { result: [], result_info: { total_pages: 2 } },
  ]), error => error.statusCode === 502);
});

test("an empty probe after a full page is valid when totals are absent", async () => {
  const { result, calls } = await run([{ result: [{ id: "a" }, { id: "b" }] }, { result: [] }]);
  assert.deepEqual(result.map(item => item.id), ["a", "b"]);
  assert.equal(calls.length, 2);
});

test("later pages retain previously declared totals and server page size", async () => {
  const first = { result: [{ id: "a" }, { id: "b" }], result_info: { page: 1, per_page: 2, total_count: 5, total_pages: 3 } };
  const second = { result: [{ id: "c" }], result_info: { page: 2 } };
  await assert.rejects(run([first, second, { result: [], result_info: { page: 3 } }]), error => error.statusCode === 502);
  const { result, calls } = await run([first, { result: [{ id: "c" }, { id: "d" }], result_info: { page: 2 } },
    { result: [{ id: "e" }], result_info: { page: 3 } }], { perPage: 50 });
  assert.equal(result.length, 5);
  assert.equal(calls.length, 3);
});

test("changing declared totals fails rather than silently accepting a new subset", async () => {
  await assert.rejects(run([
    { result: [{ id: "a" }, { id: "b" }], result_info: { total_count: 4, total_pages: 2 } },
    { result: [{ id: "c" }], result_info: { total_count: 3, total_pages: 2 } },
  ]), error => error.statusCode === 502);
});

test("the aggregate list deadline stops before another page or partial return", async t => {
  let elapsed = 0, reads = 0;
  t.mock.method(performance, "now", () => elapsed);
  const client = { async get() {
    reads += 1; elapsed += 101;
    return { result: [{ id: "a" }], result_info: { total_pages: 2 } };
  } };
  await assert.rejects(readCloudflareList({ client, path: "items", maxDurationMs: 100 }), error => error.statusCode === 502 && /超时/.test(error.message));
  assert.equal(reads, 1);
});
