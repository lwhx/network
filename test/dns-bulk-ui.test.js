import { test } from "node:test";
import assert from "node:assert/strict";
import { state, resetSessionState } from "../public/js/state.js";
import { createDnsActions } from "../public/js/actions/dns-actions.js";
import { renderDnsView } from "../public/js/views/dns-view.js";

const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function ui(t) {
  const previous = { fetch: global.fetch, FormData: global.FormData, window: global.window };
  resetSessionState();
  state.activeCloudflareAccountId = "cf-a";
  state.selectedZone = { id: "a".repeat(32), name: "example.com" };
  global.FormData = class { get() { return "A first 192.0.2.1\nA second 192.0.2.2\nA third 192.0.2.3"; } };
  global.window = { confirm: () => true };
  t.after(() => { Object.assign(global, previous); resetSessionState(); });
  return createDnsActions({ renderApp() {} });
}

test("batch create displays per-item outcomes and retries only eligible failures", async (t) => {
  const actions = ui(t);
  const input = [{ type: "A", name: "first", content: "192.0.2.1" }, { type: "A", name: "second", content: "192.0.2.2" }, { type: "A", name: "third", content: "192.0.2.3" }];
  const posts = [];
  global.fetch = async (url, options = {}) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body));
      return response(posts.length === 1 ? { records: [{ id: "created" }], results: [
        { index: 0, status: "success", input: input[0], retryable: false },
        { index: 1, status: "failed", input: input[1], error: "permission denied", retryable: true },
        { index: 2, status: "unknown", input: input[2], error: "timeout", retryable: false }],
        summary: { total: 3, succeeded: 1, failed: 1, unknown: 1, skipped: 0 } } :
        { records: [{ id: "retried" }], results: [{ index: 0, status: "success", input: input[1], retryable: false }],
          summary: { total: 1, succeeded: 1, failed: 0, unknown: 0, skipped: 0 } }, 207);
    }
    return response({ records: [] });
  };
  await actions.submitDnsBulk({ preventDefault() {}, currentTarget: {} });
  assert.equal(state.dnsBulkResult?.summary.succeeded, 1);
  const html = renderDnsView();
  assert.match(html, /permission denied/);
  assert.match(html, /结果未确认/);
  assert.match(html, /dns-bulk-retry/);
  await actions.retryDnsBulk();
  assert.deepEqual(posts[1].records, [input[1]]);
  assert.equal(state.dnsBulkResult.summary.succeeded, 2);
  assert.equal(state.dnsBulkResult.summary.unknown, 1);
});

test("batch delete counts only confirmed successes and keeps retryable items", async (t) => {
  const actions = ui(t);
  state.selectedDnsRecordIds = ["a".repeat(32), "b".repeat(32)];
  global.fetch = async (url, options = {}) => options.method === "POST" ? response({ deleted: [{ id: "a".repeat(32) }],
    results: [{ index: 0, recordId: "a".repeat(32), status: "success", retryable: false },
      { index: 1, recordId: "b".repeat(32), status: "failed", error: "denied", retryable: true }],
    summary: { total: 2, succeeded: 1, failed: 1, unknown: 0, skipped: 0 } }, 207) : response({ records: [] });
  await actions.deleteSelectedDnsRecords();
  assert.equal(state.dnsBulkResult?.summary.succeeded, 1);
  assert.match(state.notice, /成功 1/);
  assert.doesNotMatch(state.notice, /已批量删除 2/);
});

test("a completed DNS write on an old zone does not refresh or clear the new zone form", async (t) => {
  const actions = ui(t);
  const requests = [];
  let finish;
  global.fetch = (url, options = {}) => { requests.push(url); return options.method === "POST"
    ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(response({ records: [] })); };
  const pending = actions.submitDnsBulk({ preventDefault() {}, currentTarget: {} });
  state.selectedZone = { id: "b".repeat(32) };
  state.dnsBulkText = "new-zone draft";
  finish(response({ records: [], results: [], summary: { total: 0, succeeded: 0, failed: 0, unknown: 0, skipped: 0 } }));
  await pending;
  assert.equal(state.dnsBulkText, "new-zone draft");
  assert.equal(requests.length, 1);
});
