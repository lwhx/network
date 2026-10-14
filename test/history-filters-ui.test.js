import { test } from "node:test";
import assert from "node:assert/strict";
import { state, resetOperationHistoryState } from "../public/js/state.js";
import { createHistoryActions } from "../public/js/actions/history-actions.js";
import { renderHistoryView } from "../public/js/views/history-view.js";

test("history sends account, zone, time and pagination filters", async (t) => {
  const before = global.fetch;
  t.after(() => { global.fetch = before; resetOperationHistoryState(); });
  resetOperationHistoryState();
  Object.assign(state, { mainSection: "history", view: "domains", operationHistoryAccountId: "cf-a", operationHistoryZoneId: "a".repeat(32),
    operationHistoryFrom: "2026-10-13T08:00", operationHistoryTo: "2026-10-14T08:00", operationHistoryOffset: 20, operationHistoryLimit: "20" });
  let requested;
  global.fetch = async (url) => { requested = new URL(url, "http://test"); return new Response(JSON.stringify({ history: { entries: [], filteredTotal: 40, total: 60,
    filters: { accounts: [{ id: "cf-a", name: "Account A" }], zones: [{ id: "a".repeat(32), name: "alpha.example", accountId: "cf-a" }], modules: [], statuses: ["partial", "unknown"] } } }), { headers: { "Content-Type": "application/json" } }); };
  await createHistoryActions({ renderApp() {} }).loadOperationHistory();
  assert.equal(requested.searchParams.get("accountId"), "cf-a");
  assert.equal(requested.searchParams.get("zoneId"), "a".repeat(32));
  assert.equal(requested.searchParams.get("offset"), "20");
  assert.equal(requested.searchParams.get("from"), new Date("2026-10-13T08:00").toISOString());
  assert.equal(state.operationHistoryFilteredTotal, 40);
  assert.equal(state.operationHistoryFilters.accounts[0].name, "Account A");
});

test("history labels persisted, partial and unknown results and exposes account/time filters", (t) => {
  const before = global.document; const app = { innerHTML: "" };
  global.document = { querySelector: () => app };
  t.after(() => { global.document = before; resetOperationHistoryState(); });
  resetOperationHistoryState();
  state.operationHistory = [{ id: "p", status: "partial", accountName: "Account A", zoneName: "alpha.example", module: "DNS 记录", createdAt: new Date().toISOString(), durationMs: 1 }];
  renderHistoryView();
  assert.match(app.innerHTML, /部分成功/);
  assert.match(app.innerHTML, /结果未确认/);
  assert.match(app.innerHTML, /Account A/);
  assert.match(app.innerHTML, /data-history-filter="accountId"/);
  assert.match(app.innerHTML, /data-history-filter="from"/);
  assert.doesNotMatch(app.innerHTML, /当前服务进程内|重启后.*清空/);
});
