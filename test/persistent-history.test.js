import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperationHistoryService } from "../src/services/operation-history-service.js";
import { OperationHistoryController } from "../src/controllers/operation-history-controller.js";
import { SqliteStore } from "../src/services/sqlite-store.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "history-test-"));
  const databasePath = join(directory, "panel.sqlite");
  const stores = [];
  t.after(() => {
    for (const store of stores) {
      try { store.close(); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    databasePath,
    open(maxEntries = 300) {
      const store = new SqliteStore({ databasePath });
      stores.push(store);
      return { store, history: new OperationHistoryService({ store, maxEntries }) };
    },
  };
}

function operation(id, extra = {}) {
  return {
    id, method: "PATCH", pathname: "/api/zones/zone-a/dns-records/record-a",
    accountId: "account-a", accountName: "Deleted account", zoneId: "zone-a",
    zoneName: "alpha.example", createdAt: "2026-06-01T10:00:00Z", ...extra,
  };
}

test("history survives closing SQLite and reopening the panel without replacing legacy tables", (t) => {
  const database = fixture(t);
  const first = database.open();
  first.store.database.exec("CREATE TABLE legacy_configuration (value TEXT); INSERT INTO legacy_configuration VALUES ('keep')");
  first.history.record(operation("first"));
  first.store.close();
  const second = database.open();
  assert.equal(second.history.list().entries[0]?.id, "first");
  assert.equal(second.store.database.prepare("SELECT value FROM legacy_configuration").get().value, "keep");
  assert.equal(second.history.list().entries[0].accountName, "Deleted account");
});

test("separate SQLite connections see each other's writes and global clears", (t) => {
  const database = fixture(t);
  const first = database.open();
  const second = database.open();
  first.history.record(operation("first"));
  assert.equal(second.history.list().total, 1);
  second.history.record(operation("second"));
  assert.deepEqual(first.history.list().entries.map((entry) => entry.id), ["second", "first"]);
  assert.deepEqual(second.history.clear(), { deleted: 2 });
  assert.equal(first.history.list().total, 0);
});

test("retention prunes oldest insertion deterministically across instances and restart", (t) => {
  const database = fixture(t);
  const first = database.open(3);
  const second = database.open(3);
  for (let i = 1; i <= 5; i++) {
    (i % 2 ? first : second).history.record(operation(`record-${i}`));
  }
  assert.deepEqual(first.history.list().entries.map((entry) => entry.id), ["record-5", "record-4", "record-3"]);
  assert.equal(database.open(3).history.list().total, 3);
});

test("history filters account and domain together, time inclusively, and paginates with counts", (t) => {
  const { history } = fixture(t).open();
  history.record(operation("older", { createdAt: "2026-05-01T00:00:00Z" }));
  history.record(operation("other-account", { accountId: "account-b", accountName: "Beta account" }));
  history.record(operation("other-zone", { zoneId: "zone-b", zoneName: "beta.example" }));
  history.record(operation("failed", { status: "failed" }));
  history.record(operation("partial", { status: "partial", createdAt: "2026-06-02T00:00:00Z" }));
  history.record(operation("unknown", { status: "unknown", createdAt: "2026-06-03T00:00:00Z" }));
  const query = { accountId: "account-a", zoneId: "zone-a", from: "2026-06-01T00:00:00Z", to: "2026-06-03T00:00:00Z", limit: 1, offset: 1 };
  const result = history.list(query);
  assert.equal(result.total, 6);
  assert.equal(result.filteredTotal, 3);
  assert.deepEqual(result.entries.map((entry) => entry.id), ["partial"]);
  assert.equal(history.list({ ...query, offset: 0, status: "unknown" }).entries[0].id, "unknown");
  assert.equal(history.list({ ...query, module: "Workers" }).filteredTotal, 0);
  assert.deepEqual(result.filters.accounts, [{ id: "account-b", name: "Beta account" }, { id: "account-a", name: "Deleted account" }]);
  assert.deepEqual(result.filters.zones, [{ id: "zone-a", name: "alpha.example", accountId: "account-a" }, { id: "zone-b", name: "beta.example", accountId: "account-a" }]);
  assert.deepEqual(result.filters.statuses, ["success", "partial", "failed", "unknown"]);
});

test("invalid time filters and inverted intervals reject with HTTP 400", (t) => {
  const { history } = fixture(t).open();
  for (const query of [{ from: "garbage" }, { to: "2026-02-30" }, { from: "2026-06-02", to: "2026-06-01" }]) {
    assert.throws(() => history.list(query), (error) => error.statusCode === 400);
  }
});

test("filter labels retain the latest known name when a later operation has only IDs", (t) => {
  const { history } = fixture(t).open();
  history.record(operation("old-labels"));
  history.record(operation("new-labels", { accountName: "Renamed account", zoneName: "renamed.example" }));
  history.record(operation("ids-only", { accountName: "", zoneName: "" }));
  const { filters } = history.list();
  assert.deepEqual(filters.accounts, [{ id: "account-a", name: "Renamed account" }]);
  assert.deepEqual(filters.zones, [{ id: "zone-a", name: "renamed.example", accountId: "account-a" }]);
});

test("persisted history excludes bodies, credentials, query strings, arbitrary params, and raw errors", (t) => {
  const database = fixture(t);
  const { store, history } = database.open();
  history.record(operation("secret-test", {
    pathname: "/api/zones/zone-a/dns-records?token=secret-query",
    params: { zoneId: "zone-a", content: "secret-params", globalApiKey: "secret-param-key" },
    body: { content: "secret-body" }, credentials: { key: "secret-credential" },
    status: "failed", error: "Cloudflare SQL secret-error secret-body", safeError: "secret-safe-error",
    summary: { total: 3, succeeded: 1, failed: 1, unknown: 1, skipped: 0, body: "secret-summary" },
  }));
  const row = history.list().entries[0];
  assert.equal(row.error, "操作失败");
  assert.deepEqual(row.summary, { total: 3, succeeded: 1, failed: 1, unknown: 1, skipped: 0 });
  assert.equal(row.path, "zones/zone-a/dns-records");
  store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const contents = readFileSync(database.databasePath).toString();
  for (const secret of ["secret-query", "secret-params", "secret-param-key", "secret-body", "secret-credential", "secret-error", "secret-safe-error", "secret-summary"]) {
    assert.equal(JSON.stringify(row).includes(secret), false, secret);
    assert.equal(contents.includes(secret), false, secret);
  }
});

test("known DNS validation error is retained while partial and unknown retain fixed messages", (t) => {
  const { history } = fixture(t).open();
  assert.equal(history.record(operation("validation", { status: "failed", error: "DNS 记录类型暂不支持" })).error, "DNS 记录类型暂不支持");
  assert.equal(history.record(operation("partial", { status: "partial", error: "secret" })).error, "部分操作未完成");
  assert.equal(history.record(operation("unknown", { status: "unknown", error: "secret" })).error, "操作结果未知");
  assert.equal(history.record(operation("summary", { summary: { total: -1, failed: Infinity, unknown: "2", skipped: 0 } })).summary.skipped, 0);
  assert.equal(Object.hasOwn(history.list().entries[0].summary, "failed"), false);
});

test("controller forwards all global history filters without applying active account scope", async () => {
  const service = new OperationHistoryService();
  service.record(operation("a"));
  service.record(operation("b", { accountId: "account-b" }));
  const controller = new OperationHistoryController({ operationHistoryService: service });
  const result = await controller.list({ url: new URL("http://panel/api/operation-history?accountId=account-b&zoneId=zone-a&from=2026-06-01&to=2026-06-02&offset=0&limit=1"), session: { activeCloudflareAccountId: "account-a" } });
  assert.equal(result.body.history.filteredTotal, 1);
  assert.equal(result.body.history.entries[0].id, "b");
});
