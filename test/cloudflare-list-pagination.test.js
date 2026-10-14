import assert from "node:assert/strict";
import { test } from "node:test";
import { ZonesService } from "../src/services/cloudflare/zones-service.js";
import { WorkersService } from "../src/services/cloudflare/workers-service.js";
import { DeveloperResourcesService } from "../src/services/cloudflare/developer-resources-service.js";
import { DnsRecordsService } from "../src/services/cloudflare/dns-records-service.js";
import { SpeedDeployService } from "../src/services/cloudflare/speed-deploy-service.js";
import { AutomationService } from "../src/services/cloudflare/automation-service.js";

const zoneId = "a".repeat(32), accountId = "b".repeat(32);
const items = [1, 2, 3].map(index => ({ id: String(index).padStart(32, "0"), name: `name-${index}.example`, title: `namespace-${index}`,
  type: "A", content: "192.0.2.1", ttl: 1 }));

function numberedClient(records = items) {
  const calls = [];
  return { calls, client: { async get(path, query) {
    calls.push({ path, query });
    const page = query?.page || 1;
    const result = records.slice((page - 1) * 2, page * 2);
    return { result, result_info: { page, per_page: 2, count: result.length, total_count: records.length } };
  } } };
}

for (const Service of [ZonesService, WorkersService, DeveloperResourcesService]) {
  test(`${Service.name} loads accounts using total_count without total_pages`, async () => {
    const { client, calls } = numberedClient();
    const service = new Service({ cloudflareClient: client, perPage: 2 });
    assert.equal((await service.listAccounts()).length, 3);
    assert.deepEqual(calls.map(call => call.query.page), [1, 2]);
  });
}

test("zone listing loads all pages described by total_count", async () => {
  const { client, calls } = numberedClient();
  assert.equal((await new ZonesService({ cloudflareClient: client, perPage: 2 }).listZones()).length, 3);
  assert.equal(calls.length, 2);
});

for (const [Service, method] of [[DnsRecordsService, "listRecords"], [SpeedDeployService, "listRawDnsRecords"], [AutomationService, "listRawDnsRecords"]]) {
  test(`${Service.name} loads every DNS page for display and preflight`, async () => {
    const { client, calls } = numberedClient();
    const service = new Service({ cloudflareClient: client, perPage: 2 });
    assert.equal((await service[method](zoneId)).length, 3);
    assert.equal(calls.length, 2);
  });
}

for (const type of ["kv", "d1", "pages", "tunnels"]) {
  test(`${type} resource listing loads total_count pages`, async () => {
    const { client, calls } = numberedClient();
    const get = client.get;
    client.get = (path, query) => path === "accounts"
      ? Promise.resolve({ result: [{ id: accountId }], result_info: { total_pages: 1 } }) : get(path, query);
    const service = new DeveloperResourcesService({ cloudflareClient: client, perPage: 2 });
    assert.equal((await service.list(type, accountId)).items.length, 3);
    assert.deepEqual(calls.map(call => call.query.page), [1, 2]);
  });
}

test("an account on a later page remains selectable in developer resources", async () => {
  const accounts = items.map(item => ({ ...item, id: item.id }));
  const { client } = numberedClient(accounts);
  const service = new DeveloperResourcesService({ cloudflareClient: client, perPage: 2 });
  assert.equal((await service.resolveAccountId(accounts[2].id)).accountId, accounts[2].id);
});

test("R2 bucket cursors are passed without an unrelated numbered page", async () => {
  const queries = [];
  const client = { async get(path, query) {
    if (path === "accounts") return { result: [{ id: accountId }] };
    queries.push(query);
    return { result: { buckets: [{ name: query.cursor ? "second-bucket" : "first-bucket" }] },
      result_info: { cursor: query.cursor ? "" : " next+/= " } };
  } };
  const result = await new DeveloperResourcesService({ cloudflareClient: client }).list("r2", accountId);
  assert.deepEqual(result.items.map(item => item.name), ["first-bucket", "second-bucket"]);
  assert.equal(queries[0].page, undefined);
  assert.equal(queries[1].page, undefined);
  assert.equal(queries[1].cursor, " next+/= ");
});

for (const mode of ["repeat", "cycle"]) {
  test(`R2 ${mode} cursor errors instead of returning a partial list or looping`, async () => {
    let reads = 0;
    const client = { async get(path) {
      if (path === "accounts") return { result: [{ id: accountId }] };
      reads += 1;
      if (reads > 4) throw new Error("mock stopped an unbounded loop");
      return { result: { buckets: [{ name: `bucket-${reads}` }] }, result_info: { cursor: mode === "repeat" ? "one" : reads % 2 ? "one" : "two" } };
    } };
    await assert.rejects(new DeveloperResourcesService({ cloudflareClient: client }).list("r2", accountId), error => error.statusCode === 502);
    assert.ok(reads <= 3);
  });
}

test("a numbered list that repeats a page cannot be mistaken for a complete list", async () => {
  let reads = 0;
  const client = { async get(path, query) {
    reads += 1;
    return { result: [items[0]], result_info: { page: query.page, per_page: 1, total_count: 2 } };
  } };
  await assert.rejects(new ZonesService({ cloudflareClient: client, perPage: 1 }).listZones(), error => error.statusCode === 502);
  assert.equal(reads, 2);
});

test("a failure on a later DNS page propagates instead of returning earlier records", async () => {
  const client = { async get(path, query) {
    if (query.page === 2) throw Object.assign(new Error("page unavailable"), { statusCode: 503 });
    return { result: [items[0]], result_info: { page: 1, per_page: 1, total_count: 2 } };
  } };
  await assert.rejects(new DnsRecordsService({ cloudflareClient: client, perPage: 1 }).listRecords(zoneId), error => error.statusCode === 503);
});

for (const mode of ["conflict", "failed-page", "empty-terminal", "overlapping-terminal", "missing-totals"]) {
  test(`acceleration makes no writes when a later DNS page contains ${mode}`, async () => {
    const writes = [], pages = [];
    const source = { ...items[0], name: "origin.alpha.example" };
    const client = {
      getCredentials() { return { email: "fixture@example.com" }; },
      async get(path, query) {
        if (path === `zones/${zoneId}`) return { result: { name: "alpha.example" } };
        if (path.endsWith("/dns_records")) {
          pages.push(query.page);
          if (query.page === 2 && mode === "failed-page") throw Object.assign(new Error("page failed"), { statusCode: 503 });
          if (mode === "missing-totals") return {
            result: query.page === 1 ? [source, { ...items[1], name: "unrelated.alpha.example" }] : [{ ...items[2], name: "another.alpha.example" }],
            result_info: query.page === 1 ? { page: 1, per_page: 2, total_count: 4, total_pages: 2 } : { page: 2 },
          };
          if (mode.endsWith("terminal")) return {
            result: query.page === 1 ? [source, { ...items[1], name: "unrelated.alpha.example" }]
              : mode === "empty-terminal" ? [] : [source, { ...items[2], name: "another.alpha.example" }],
            result_info: { page: query.page, per_page: 2, total_count: mode === "empty-terminal" ? 3 : 4, total_pages: 2 },
          };
          return { result: query.page === 1 ? [source] : [{ ...items[1], name: "cdn.alpha.example" }],
            result_info: { page: query.page, per_page: 1, total_count: 2 } };
        }
        if (path.endsWith("/settings/ssl")) return { result: { value: "flexible" } };
        if (path.endsWith("/fallback_origin")) return { result: null };
        if (path.endsWith("/custom_hostnames")) return { result: [] };
        throw new Error("unexpected preflight read");
      },
      async post(path) { writes.push(path); throw new Error("unexpected write"); },
    };
    const service = new SpeedDeployService({ cloudflareClient: client, dnsRecordsService: new DnsRecordsService({ cloudflareClient: client }) });
    await assert.rejects(service.deploy(zoneId, { zoneName: "alpha.example", targetDomain: "origin.alpha.example",
      accessDomain: "cdn.alpha.example", optimizedDomain: "preferred.example" }), error => error.statusCode === (mode === "conflict" ? 409 : mode === "failed-page" ? 503 : 502));
    assert.deepEqual(pages, [1, 2]);
    assert.deepEqual(writes, []);
  });
}
