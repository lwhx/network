import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

import { createConfig } from "../src/config/env.js";
import { HttpError } from "../src/lib/http-error.js";
import { startServer } from "../src/server.js";
import { CloudflareClient } from "../src/services/cloudflare/cloudflare-client.js";
import { DnsRecordsService } from "../src/services/cloudflare/dns-records-service.js";
import {
  allocatePanelPort,
  makeTotp,
  preparePanelTestEnvironment,
} from "./helpers/panel-test-environment.js";

const zoneId = "a".repeat(32);
const recordIds = ["b", "c", "d"].map((value) => value.repeat(32));
const inputs = ["first", "second", "third"].map((name) => ({
  type: "A", name: `${name}.example.com`, content: "192.0.2.1", ttl: 1,
}));

function serviceWithOutcomes(outcomes) {
  const writes = [];
  const execute = async (path, body) => {
    const outcome = outcomes[writes.length];
    writes.push({ path, body });
    if (outcome instanceof Error) throw outcome;
    return { result: body ? { id: recordIds[writes.length - 1], ...body } : { id: path.split("/").at(-1) } };
  };
  return {
    writes,
    service: new DnsRecordsService({ cloudflareClient: { post: execute, delete: execute } }),
  };
}

test("legacy bulk creation validates every input before writing any record", async () => {
  const { service, writes } = serviceWithOutcomes([]);
  await assert.rejects(service.createRecords(zoneId, [inputs[0], { ...inputs[1], ttl: 2 }]),
    (error) => error.statusCode === 400);
  assert.equal(writes.length, 0);
});

test("detailed bulk creation retains successes and continues after a definite rejection", async () => {
  const { service, writes } = serviceWithOutcomes([null, new HttpError(409, "already exists"), null]);
  const response = await service.createRecordsDetailed(zoneId, inputs);
  assert.deepEqual(response.results.map(({ index, status, retryable }) => ({ index, status, retryable })), [
    { index: 0, status: "success", retryable: false },
    { index: 1, status: "failed", retryable: true },
    { index: 2, status: "success", retryable: false },
  ]);
  assert.deepEqual(response.records.map((record) => record.name), [inputs[0].name, inputs[2].name]);
  assert.deepEqual(response.results[1].input, inputs[1]);
  assert.equal(response.results[1].error, "already exists");
  assert.equal(response.results[0].record.id, recordIds[0]);
  assert.deepEqual(response.summary, { total: 3, succeeded: 2, failed: 1, unknown: 0, skipped: 0 });
  assert.equal(writes.length, 3);

  const retry = serviceWithOutcomes([]);
  const retryResponse = await retry.service.createRecordsDetailed(zoneId,
    response.results.filter((item) => item.retryable).map((item) => item.input));
  assert.deepEqual(retryResponse.records.map((record) => record.name), [inputs[1].name]);
});

test("detailed creation provides the normalized request body for a safe retry", async () => {
  const { service } = serviceWithOutcomes([new HttpError(429, "rate limited")]);
  const response = await service.createRecordsDetailed(zoneId, [{
    type: " mx ", name: " mail.example.com ", content: " mx.example.com ",
    ttl: "300", proxied: true, comment: " mail ", extra: "discard",
  }]);
  assert.deepEqual(response.results[0].input, {
    type: "MX", name: "mail.example.com", content: "mx.example.com", ttl: 300,
    priority: 10, comment: "mail",
  });
});

test("detailed creation stops after an uncertain remote write without retrying that item", async () => {
  const unknown = Object.assign(new HttpError(504, "timed out"), { remoteOutcomeUnknown: true });
  const { service, writes } = serviceWithOutcomes([null, unknown]);
  const response = await service.createRecordsDetailed(zoneId, inputs);
  assert.deepEqual(response.results.map((item) => item.status), ["success", "unknown", "skipped"]);
  assert.deepEqual(response.results.map((item) => item.retryable), [false, false, true]);
  assert.equal(response.results[1].error, "timed out");
  assert.ok(response.results[2].error);
  assert.deepEqual(response.results[2].input, inputs[2]);
  assert.deepEqual(response.summary, { total: 3, succeeded: 1, failed: 0, unknown: 1, skipped: 1 });
  assert.equal(writes.length, 2);
});

test("detailed creation rejects malformed batches before writes", async () => {
  for (const batch of [[], null, {}, Array(101).fill(inputs[0]), [inputs[0], null], [inputs[0], "bad"],
    [inputs[0], { ...inputs[1], name: "" }]]) {
    const { service, writes } = serviceWithOutcomes([]);
    await assert.rejects(service.createRecordsDetailed(zoneId, batch), (error) => error.statusCode === 400);
    assert.equal(writes.length, 0);
  }
});

test("detailed deletion retains successes and continues after definite failure", async () => {
  const { service, writes } = serviceWithOutcomes([null, new HttpError(403, "forbidden"), null]);
  const response = await service.deleteRecordsDetailed(zoneId, recordIds);
  assert.deepEqual(response.results.map((item) => item.status), ["success", "failed", "success"]);
  assert.deepEqual(response.deleted, [{ id: recordIds[0] }, { id: recordIds[2] }]);
  assert.equal(response.results[1].recordId, recordIds[1]);
  assert.equal(response.results[1].error, "forbidden");
  assert.equal(response.results[1].retryable, true);
  assert.deepEqual(response.results[0].result, { id: recordIds[0] });
  assert.deepEqual(response.summary, { total: 3, succeeded: 2, failed: 1, unknown: 0, skipped: 0 });
  assert.equal(writes.length, 3);
});

test("detailed deletion stops remaining writes after uncertain outcome", async () => {
  const unknown = Object.assign(new HttpError(502, "connection lost"), { remoteOutcomeUnknown: true });
  const { service, writes } = serviceWithOutcomes([unknown]);
  const response = await service.deleteRecordsDetailed(zoneId, recordIds);
  assert.deepEqual(response.results.map((item) => item.status), ["unknown", "skipped", "skipped"]);
  assert.deepEqual(response.results.map((item) => item.retryable), [false, true, true]);
  assert.deepEqual(response.deleted, []);
  assert.equal(writes.length, 1);
});

test("detailed deletion validates all IDs and batch limits before writes", async () => {
  for (const batch of [[], null, {}, Array(101).fill(recordIds[0]), [recordIds[0], "invalid"]]) {
    const { service, writes } = serviceWithOutcomes([]);
    await assert.rejects(service.deleteRecordsDetailed(zoneId, batch), (error) => error.statusCode === 400);
    assert.equal(writes.length, 0);
  }
});

test("duplicate delete IDs have explicit results without duplicate remote writes", async () => {
  const { service, writes } = serviceWithOutcomes([]);
  const response = await service.deleteRecordsDetailed(zoneId, [recordIds[0], ` ${recordIds[1]} `, recordIds[0]]);
  assert.deepEqual(response.results.map((item) => [item.index, item.status, item.recordId]), [
    [0, "success", recordIds[0]], [1, "success", recordIds[1]], [2, "success", recordIds[0]],
  ]);
  assert.deepEqual(response.deleted, [{ id: recordIds[0] }, { id: recordIds[1] }]);
  assert.deepEqual(response.summary, { total: 3, succeeded: 3, failed: 0, unknown: 0, skipped: 0 });
  assert.equal(writes.length, 2);
});

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

test("real Cloudflare transport loss produces unknown and skips later DNS creates", async (t) => {
  const writes = [];
  const mock = createServer(async (request) => {
    for await (const chunk of request) { void chunk; }
    writes.push(request.url);
    request.socket.destroy();
  });
  const apiBaseUrl = await listen(mock);
  t.after(() => new Promise((resolve) => mock.close(resolve)));
  const client = new CloudflareClient({ apiBaseUrl, email: "admin@example.com", globalApiKey: "test-key", requestTimeoutMs: 1000 });
  const response = await new DnsRecordsService({ cloudflareClient: client }).createRecordsDetailed(zoneId, inputs);
  assert.deepEqual(response.results.map((item) => item.status), ["unknown", "skipped", "skipped"]);
  assert.equal(response.results[0].retryable, false);
  assert.equal(writes.length, 1);
});

test("malformed successful DNS create and delete results are unknown and stop later writes", async () => {
  for (const operation of ["create", "delete"]) {
    for (const result of [null, {}, "invalid"]) {
      const writes = [];
      const execute = async (path) => {
        writes.push(path);
        return { success: true, result };
      };
      const service = new DnsRecordsService({ cloudflareClient: { post: execute, delete: execute } });
      const response = operation === "create"
        ? await service.createRecordsDetailed(zoneId, inputs)
        : await service.deleteRecordsDetailed(zoneId, recordIds);
      assert.deepEqual(response.results.map((item) => item.status), ["unknown", "skipped", "skipped"]);
      assert.equal(response.results[0].retryable, false);
      assert.equal(writes.length, 1);
    }
  }
});

test("ambiguous Cloudflare write responses are unknown rather than retryable failures", async () => {
  for (const operation of ["create", "delete"]) {
    for (const [status, body] of [
      [200, "not json"], [200, "{}"], [200, '{"result":{}}'],
      [500, '{"success":false,"errors":[{"message":"server error"}]}'],
      [503, "unavailable"],
    ]) {
      let writes = 0;
      const client = new CloudflareClient({
        apiBaseUrl: "https://cloudflare.invalid", email: "admin@example.com", globalApiKey: "test-key", requestTimeoutMs: 1000,
        fetchImpl: async () => {
          writes += 1;
          return new Response(body, { status });
        },
      });
      const service = new DnsRecordsService({ cloudflareClient: client });
      const response = operation === "create"
        ? await service.createRecordsDetailed(zoneId, inputs)
        : await service.deleteRecordsDetailed(zoneId, recordIds);
      assert.deepEqual(response.results.map((item) => item.status), ["unknown", "skipped", "skipped"], `${operation} status ${status}: ${body}`);
      assert.equal(response.results[0].retryable, false);
      assert.equal(writes, 1);
    }
  }
});

test("Cloudflare explicit rejections remain definite and malformed 2xx failures use HTTP502", async () => {
  for (const [status, body, unknown] of [
    [200, "{}", true],
    [200, '{"success":false,"errors":[{"message":"rejected"}]}', false],
    [409, '{"success":false,"errors":[{"message":"rejected"}]}', false],
  ]) {
    const client = new CloudflareClient({
      apiBaseUrl: "https://cloudflare.invalid", email: "admin@example.com", globalApiKey: "test-key", requestTimeoutMs: 1000,
      fetchImpl: async () => new Response(body, { status }),
    });
    await assert.rejects(client.post("dns_records", inputs[0]), (error) => {
      assert.equal(error.statusCode, status === 200 ? 502 : status);
      assert.equal(Boolean(error.remoteOutcomeUnknown), unknown);
      return true;
    });
  }
});

test("DNS deletion accepts an explicit HTTP204 without a JSON result", async () => {
  const client = new CloudflareClient({
    apiBaseUrl: "https://cloudflare.invalid", email: "admin@example.com", globalApiKey: "test-key", requestTimeoutMs: 1000,
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  const response = await new DnsRecordsService({ cloudflareClient: client }).deleteRecordsDetailed(zoneId, recordIds);
  assert.deepEqual(response.results.map((item) => item.status), ["success", "success", "success"]);
  assert.deepEqual(response.deleted, recordIds.map((id) => ({ id })));
});

test("authenticated DNS bulk API returns per-item outcomes, prevents invalid writes and protects mutations", async (t) => {
  const writes = [];
  const mock = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    if (request.method === "POST" || request.method === "DELETE") {
      writes.push({ method: request.method, body, path: request.url });
      assert.equal(request.headers["x-auth-email"], "admin@example.com");
      assert.equal(request.headers["x-auth-key"], "test-global-api-key");
    }
    if (body?.name === inputs[1].name || request.url.endsWith(recordIds[1])) {
      sendJson(response, 409, { success: false, errors: [{ message: "already exists" }] });
      return;
    }
    sendJson(response, 200, { success: true, result: body ? { id: recordIds[0], ...body } : { id: request.url.split("/").at(-1) } });
  });
  const apiBaseUrl = await listen(mock);
  t.after(() => new Promise((resolve) => mock.close(resolve)));
  const panelPort = await allocatePanelPort();
  const prepared = preparePanelTestEnvironment({ PORT: String(panelPort), AUTH: "JBSWY3DPEHPK3PXP", CLOUDFLARE_API_BASE_URL: apiBaseUrl });
  const panel = startServer({ config: createConfig(prepared.env), logger: { log() {} } });
  await once(panel, "listening");
  t.after(async () => {
    await new Promise((resolve) => panel.close(resolve));
    prepared.cleanup();
  });
  const origin = `http://127.0.0.1:${panelPort}`;
  const bulkUrl = `${origin}/api/zones/${zoneId}/dns-records/bulk`;
  const deleteUrl = `${origin}/api/zones/${zoneId}/dns-records/bulk-delete`;
  await fetch(`${origin}/api/session/status`, { headers: { "x-panel-test-prepare": "true" } });
  const login = await fetch(`${origin}/api/session/connect`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "operator", password: "strong-password", auth: makeTotp("JBSWY3DPEHPK3PXP") }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];

  for (const url of [bulkUrl, deleteUrl]) {
    const unauthenticated = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", "x-panel-test-skip-auth": "true" },
      body: JSON.stringify({ records: inputs, recordIds }),
    });
    assert.equal(unauthenticated.status, 401);
    const csrfMissing = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ records: inputs, recordIds }),
    });
    assert.equal(csrfMissing.status, 403);
  }
  assert.equal(writes.length, 0);

  const post = (url, body) => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  for (const body of [null, { records: [inputs[0], { ...inputs[1], ttl: 2 }] }, { records: [inputs[0], null] }]) {
    const invalid = await post(bulkUrl, body);
    assert.equal(invalid.status, 400);
  }
  const invalidDelete = await post(deleteUrl, { recordIds: [recordIds[0], "invalid"] });
  assert.equal(invalidDelete.status, 400);
  assert.equal(writes.length, 0);

  const mixed = await post(bulkUrl, { records: inputs });
  assert.equal(mixed.status, 207);
  assert.equal(mixed.ok, true);
  const created = await mixed.json();
  assert.deepEqual(created.results.map((item) => item.status), ["success", "failed", "success"]);
  assert.equal(created.records.length, 2);
  assert.deepEqual(created.summary, { total: 3, succeeded: 2, failed: 1, unknown: 0, skipped: 0 });

  const mixedDelete = await post(deleteUrl, { recordIds });
  assert.equal(mixedDelete.status, 207);
  const deleted = await mixedDelete.json();
  assert.deepEqual(deleted.results.map((item) => item.status), ["success", "failed", "success"]);
  assert.equal(deleted.deleted.length, 2);

  const allCreated = await post(bulkUrl, [inputs[0]]);
  assert.equal(allCreated.status, 201);
  assert.equal((await allCreated.json()).summary.succeeded, 1);
  const allDeleted = await post(deleteUrl, [recordIds[0]]);
  assert.equal(allDeleted.status, 200);
  assert.equal((await allDeleted.json()).summary.succeeded, 1);
  const allFailed = await post(bulkUrl, [inputs[1]]);
  assert.equal(allFailed.status, 207);
  assert.equal((await allFailed.json()).summary.failed, 1);
});
