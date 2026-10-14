import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

import { HttpError } from "../src/lib/http-error.js";
import { CloudflareClient } from "../src/services/cloudflare/cloudflare-client.js";
import { DnsRecordsService } from "../src/services/cloudflare/dns-records-service.js";

function client(options = {}) {
  return new CloudflareClient({
    apiBaseUrl: "https://cloudflare.invalid", email: "test@example.com",
    globalApiKey: "test-key", requestTimeoutMs: 150, ...options,
  });
}

async function slowBodyServer(t, status = 200) {
  const requests = [];
  const timers = new Set();
  const server = createServer((request, response) => {
    requests.push(request.method);
    request.resume();
    response.writeHead(status, { "Content-Type": "application/json" });
    response.write('{"success":true,"data":{},"result":');
    const timer = setTimeout(() => response.end('{}}'), 700);
    timers.add(timer);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return { requests, apiBaseUrl: `http://127.0.0.1:${server.address().port}` };
}

const calls = [
  ["JSON read", "GET", api => api.get("resource")],
  ["JSON create", "POST", api => api.post("resource", {})],
  ["JSON update", "PATCH", api => api.patch("resource", {})],
  ["JSON replace", "PUT", api => api.put("resource", {})],
  ["JSON delete", "DELETE", api => api.delete("resource")],
  ["optional-body delete", "DELETE", api => api.deleteAny("resource")],
  ["text read", "GET", api => api.getText("resource")],
  ["multipart upload", "PUT", api => api.putMultipart("resource", new FormData())],
  ["raw read", "GET", async api => (await api.getRaw("resource")).text()],
  ["raw upload", "PUT", api => api.putRaw("resource", "value")],
  ["GraphQL read", "POST", api => api.graphql("query { viewer { id } }")],
];

for (const [name, method, invoke] of calls) {
  test(`${name} times out while reading a stalled response body`, async t => {
    const env = await slowBodyServer(t);
    await assert.rejects(invoke(client({ apiBaseUrl: env.apiBaseUrl })), error => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 504);
      assert.match(error.message, /超时/);
      assert.equal(Boolean(error.remoteOutcomeUnknown), method !== "GET" && name !== "GraphQL read");
      if (error.remoteOutcomeUnknown) assert.match(error.message, /写入结果未确认.*核查/);
      return true;
    });
    assert.deepEqual(env.requests, [method]);
  });
}

test("a stalled successful DNS create remains unknown and stops later writes", async t => {
  const env = await slowBodyServer(t);
  const service = new DnsRecordsService({ cloudflareClient: client({ apiBaseUrl: env.apiBaseUrl }) });
  const result = await service.createRecordsDetailed("a".repeat(32), ["one", "two"].map(name => ({
    type: "A", name: `${name}.example.com`, content: "192.0.2.1", ttl: 1,
  })));
  assert.deepEqual(result.results.map(row => row.status), ["unknown", "skipped"]);
  assert.equal(result.results[0].retryable, false);
  assert.match(result.results[0].error, /超时/);
  assert.deepEqual(env.requests, ["POST"]);
});

test("known HTTP rejections retain their status when the error body stalls", async t => {
  const env = await slowBodyServer(t, 429);
  await assert.rejects(client({ apiBaseUrl: env.apiBaseUrl }).putRaw("resource", "value"), error => {
    assert.equal(error.statusCode, 429);
    assert.equal(Boolean(error.remoteOutcomeUnknown), false);
    return true;
  });
  assert.deepEqual(env.requests, ["PUT"]);
});

test("a stalled HTTP503 write preserves status and remains unknown", async t => {
  const env = await slowBodyServer(t, 503);
  await assert.rejects(client({ apiBaseUrl: env.apiBaseUrl }).putRaw("resource", "value"), error => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.remoteOutcomeUnknown, true);
    assert.match(error.message, /写入结果未确认.*核查/);
    return true;
  });
  assert.deepEqual(env.requests, ["PUT"]);
});

test("a stalled HTTP503 GraphQL read preserves status without write uncertainty", async t => {
  const env = await slowBodyServer(t, 503);
  await assert.rejects(client({ apiBaseUrl: env.apiBaseUrl }).graphql("query { viewer { id } }"), error => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.remoteOutcomeUnknown, false);
    return true;
  });
  assert.deepEqual(env.requests, ["POST"]);
});

test("multipart failures never return a successful HTTP status", async () => {
  for (const [status, body, unknown] of [
    [200, "{}", true],
    [200, '{"success":false,"errors":[{"message":"rejected"}]}', false],
    [503, '{"success":false,"errors":[{"message":"server error"}]}', true],
    [409, '{"success":false,"errors":[{"message":"rejected"}]}', false],
  ]) {
    const api = client({ fetchImpl: async () => new Response(body, { status }) });
    await assert.rejects(api.putMultipart("resource", new FormData()), error => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, status === 200 ? 502 : status);
      assert.equal(Boolean(error.remoteOutcomeUnknown), unknown);
      return true;
    });
  }
});

test("multipart success must be confirmed by a boolean true envelope", async () => {
  for (const success of ["true", 1, {}]) {
    const api = client({ fetchImpl: async () => Response.json({ success, result: {} }) });
    await assert.rejects(api.putMultipart("resource", new FormData()), error =>
      error.statusCode === 502 && error.remoteOutcomeUnknown === true);
  }
});

test("raw upload server failures remain unknown", async () => {
  const api = client({ fetchImpl: async () => new Response("unavailable", { status: 503 }) });
  await assert.rejects(api.putRaw("resource", "value"), error => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.remoteOutcomeUnknown, true);
    assert.match(error.message, /写入结果未确认.*核查/);
    return true;
  });
});

test("GraphQL rejects malformed success responses instead of returning empty data", async () => {
  for (const body of ["not json", "{}", '{"data":null}', '{"data":[]}']) {
    const api = client({ fetchImpl: async () => new Response(body, { status: 200 }) });
    await assert.rejects(api.graphql("query { viewer { id } }"), error => error.statusCode === 502);
  }
});

test("GraphQL rejects malformed errors even when data is present", async () => {
  for (const errors of [{ message: "rejected" }, 1, "", false]) {
    const api = client({ fetchImpl: async () => Response.json({ data: {}, errors }) });
    await assert.rejects(api.graphql("query { viewer { id } }"), error => error.statusCode === 502);
  }
});

test("unexpected upstream error shapes still produce HttpError", async () => {
  for (const invoke of [api => api.deleteAny("resource"), api => api.getText("resource"),
    api => api.putMultipart("resource", new FormData()), api => api.graphql("query { viewer { id } }")]) {
    const api = client({ fetchImpl: async () => Response.json({ success: false, errors: "invalid" }, { status: 503 }) });
    await assert.rejects(invoke(api), error => error instanceof HttpError && error.statusCode === 503);
  }
});

test("completed raw responses preserve bytes, HTTP status and headers", async () => {
  const bytes = new Uint8Array([0, 255, 65, 128]);
  const api = client({ fetchImpl: async () => new Response(bytes, {
    status: 200, headers: { "Content-Type": "application/octet-stream", etag: '"fixture"' },
  }) });
  const response = await api.getRaw("resource");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"fixture"');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});
