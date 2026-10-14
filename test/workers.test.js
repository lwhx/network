import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";

import { preparePanelTestEnvironment } from "./helpers/panel-test-environment.js";

function listen(server, port = 0) {
  server.listen(port, "127.0.0.1");
  return once(server, "listening").then(() => {
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
  });
}

async function waitForHttp(url) {
  const deadline = Date.now() + 3_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function startPanel(env) {
  const prepared = preparePanelTestEnvironment(env);
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ...prepared.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  return {
    child,
    output,
    async stop() {
      child.kill();
      await once(child, "exit").catch(() => {});
      prepared.cleanup();
    },
  };
}

function makeJsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readRequestBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");

  if (!text) {
    return { text, json: null };
  }

  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function createWorkersMock({ accountId, dnsRecords = [], zoneId, requests }) {
  const workerScript = `addEventListener('fetch', event => {
  event.respondWith(new Response('Hello from test'));
});`;
  const records = dnsRecords.map((record, index) => ({
    id: record.id || `${String(index + 1).repeat(32)}`.slice(0, 32),
    ttl: record.ttl ?? 1,
    proxied: Boolean(record.proxied),
    proxiable: true,
    comment: record.comment || "",
    created_on: "2026-01-01T00:00:00Z",
    modified_on: "2026-01-01T00:00:00Z",
    ...record,
  }));

  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const body = await readRequestBody(request);
    requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      contentType: request.headers["content-type"] || "",
      bodyText: body.text,
      body: body.json,
    });

    if (request.method === "GET" && url.pathname === "/accounts") {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: [{ id: accountId, name: "Test Account", type: "standard" }],
        result_info: { page: 1, per_page: 50, total_pages: 1, total_count: 1 },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === `/accounts/${accountId}/workers/scripts`) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: [
          {
            id: "hello-worker",
            etag: "abc123",
            usage_model: "standard",
            handlers: ["fetch"],
            modified_on: "2026-01-01T00:00:00Z",
          },
        ],
      });
      return;
    }

    if (request.method === "GET" && url.pathname === `/accounts/${accountId}/workers/domains`) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: [
          {
            id: "domain-1",
            hostname: "api.alpha.example",
            service: "hello-worker",
            environment: "production",
            zone_id: zoneId,
            zone_name: "alpha.example",
          },
        ],
        result_info: { page: 1, per_page: 50, total_count: 1 },
      });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === `/accounts/${accountId}/workers/scripts/hello-worker`
    ) {
      response.writeHead(200, { "Content-Type": "application/javascript" });
      response.end(workerScript);
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === `/accounts/${accountId}/workers/scripts/hello-worker/subdomain`
    ) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: { enabled: true, previews_enabled: true },
      });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === `/accounts/${accountId}/workers/scripts/hello-worker/subdomain`
    ) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: {
          enabled: Boolean(body.json?.enabled),
          previews_enabled: Boolean(body.json?.previews_enabled),
        },
      });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === `/accounts/${accountId}/workers/scripts/hello-worker/settings`
    ) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: {
          bindings: [{ name: "KV_CACHE", type: "kv_namespace" }],
          compatibility_date: "2026-01-01",
        },
      });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === `/accounts/${accountId}/workers/scripts/hello-worker/schedules`
    ) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: [{ cron: "*/5 * * * *", created_on: "2026-01-01T00:00:00Z" }],
      });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === `/accounts/${accountId}/workers/scripts/hello-worker/deployments`
    ) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: [{ id: "deployment-1", source: "api", created_on: "2026-01-01T00:00:00Z" }],
      });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === `/accounts/${accountId}/workers/scripts/hello-worker/secrets`
    ) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: [{ name: "API_TOKEN", type: "secret_text" }],
      });
      return;
    }

    if (request.method === "GET" && url.pathname === `/accounts/${accountId}/queues`) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: [{ queue_id: "queue-1", queue_name: "jobs" }],
      });
      return;
    }

    if (request.method === "PUT" && url.pathname === `/accounts/${accountId}/workers/scripts/hello-worker`) {
      assert.match(request.headers["content-type"] || "", /multipart\/form-data/);
      assert.match(body.text, /name="metadata"/);
      assert.match(body.text, /body_part|main_module/);
      assert.match(body.text, /Hello from upload/);
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: { id: "hello-worker", etag: "updated" },
      });
      return;
    }

    if (request.method === "DELETE" && url.pathname === `/accounts/${accountId}/workers/scripts/hello-worker`) {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === `/zones/${zoneId}`) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: { id: zoneId, name: "alpha.example" },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === `/zones/${zoneId}/workers/routes`) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: [
          { id: "route-1", pattern: "api.alpha.example/*", script: "hello-worker" },
          { id: "route-2", pattern: "beta.alpha.example/*", script: "other-worker" },
        ],
      });
      return;
    }

    if (request.method === "POST" && url.pathname === `/zones/${zoneId}/workers/routes`) {
      records.push({
        id: `route-record-${records.length}`,
        type: "ROUTE",
        name: body.json.pattern,
        content: body.json.script,
      });
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: { id: "route-3", pattern: body.json.pattern, script: body.json.script },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === `/zones/${zoneId}/dns_records`) {
      const dnsItems = records.filter((record) => record.type !== "ROUTE");
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: dnsItems,
        result_info: { page: 1, per_page: 100, total_pages: 1, total_count: dnsItems.length },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === `/zones/${zoneId}/dns_records`) {
      const record = {
        id: "c".repeat(32),
        ttl: body.json.ttl,
        proxied: Boolean(body.json.proxied),
        proxiable: true,
        comment: body.json.comment || "",
        created_on: "2026-01-01T00:00:00Z",
        modified_on: "2026-01-01T00:00:00Z",
        ...body.json,
      };
      records.push(record);
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: record,
      });
      return;
    }

    const dnsRecordMatch = url.pathname.match(
      new RegExp(`^/zones/${zoneId}/dns_records/(?<recordId>[a-z0-9]{32})$`, "i")
    );

    if (request.method === "PATCH" && dnsRecordMatch) {
      const record = records.find((item) => item.id === dnsRecordMatch.groups.recordId);

      if (!record) {
        makeJsonResponse(response, 404, {
          success: false,
          errors: [{ message: "dns record not found" }],
        });
        return;
      }

      Object.assign(record, body.json, { modified_on: "2026-01-02T00:00:00Z" });
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: record,
      });
      return;
    }

    if (request.method === "DELETE" && url.pathname === `/zones/${zoneId}/workers/routes/route-1`) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: { id: "route-1" },
      });
      return;
    }

    if (request.method === "DELETE" && url.pathname === `/zones/${zoneId}/workers/routes/route-3`) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: { id: "route-3" },
      });
      return;
    }

    if (request.method === "PUT" && url.pathname === `/accounts/${accountId}/workers/domains`) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: {
          id: "domain-2",
          hostname: body.json.hostname,
          service: body.json.service,
          environment: body.json.environment,
          zone_id: body.json.zone_id,
          zone_name: body.json.zone_name,
        },
      });
      return;
    }

    if (request.method === "DELETE" && url.pathname === `/accounts/${accountId}/workers/domains/domain-1`) {
      makeJsonResponse(response, 200, {
        success: true,
        errors: [],
        messages: [],
        result: { id: "domain-1" },
      });
      return;
    }

    makeJsonResponse(response, 404, {
      success: false,
      errors: [{ message: `not found: ${request.method} ${url.pathname}` }],
    });
  });
}

test("manages Workers scripts, subdomain, routes, and custom domains through Cloudflare APIs", async () => {
  const accountId = "1".repeat(32);
  const zoneId = "a".repeat(32);
  const requests = [];
  const cloudflareMock = createWorkersMock({ accountId, zoneId, requests });
  const mockUrl = await listen(cloudflareMock);
  const panelPort = 3230;
  const panel = startPanel({
    PORT: String(panelPort),
    CLOUDFLARE_EMAIL: "admin@example.com",
    CLOUDFLARE_GLOBAL_API_KEY: "global-key",
    CLOUDFLARE_API_BASE_URL: mockUrl,
  });

  try {
    await waitForHttp(`http://127.0.0.1:${panelPort}/`);

    const listResponse = await fetch(`http://127.0.0.1:${panelPort}/api/workers`);
    const listPayload = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(listPayload.workers.accountId, accountId);
    assert.equal(listPayload.workers.workers[0].name, "hello-worker");
    assert.equal(listPayload.workers.domains[0].hostname, "api.alpha.example");

    const detailResponse = await fetch(
      `http://127.0.0.1:${panelPort}/api/workers/hello-worker?accountId=${accountId}`
    );
    const detailPayload = await detailResponse.json();
    assert.equal(detailResponse.status, 200);
    assert.match(detailPayload.worker.script, /Hello from test/);
    assert.equal(detailPayload.worker.subdomain.enabled, true);
    assert.equal(detailPayload.worker.settings.bindings[0].name, "KV_CACHE");
    assert.equal(detailPayload.worker.schedules[0].cron, "*/5 * * * *");
    assert.equal(detailPayload.worker.deployments[0].id, "deployment-1");
    assert.equal(detailPayload.worker.secrets[0].name, "API_TOKEN");
    assert.equal(detailPayload.worker.queues[0].name, "jobs");

    const uploadResponse = await fetch(
      `http://127.0.0.1:${panelPort}/api/workers/hello-worker`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          script: "addEventListener('fetch', event => event.respondWith(new Response('Hello from upload')));",
        }),
      }
    );
    const uploadPayload = await uploadResponse.json();
    assert.equal(uploadResponse.status, 200);
    assert.equal(uploadPayload.worker.worker.etag, "updated");

    const routeListResponse = await fetch(
      `http://127.0.0.1:${panelPort}/api/workers/hello-worker/routes?zoneId=${zoneId}`
    );
    const routeListPayload = await routeListResponse.json();
    assert.equal(routeListResponse.status, 200);
    assert.deepEqual(routeListPayload.routes.map((route) => route.id), ["route-1"]);

    const routeCreateResponse = await fetch(
      `http://127.0.0.1:${panelPort}/api/workers/hello-worker/routes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zoneId, zoneName: "alpha.example", pattern: "admin" }),
      }
    );
    const routeCreatePayload = await routeCreateResponse.json();
    assert.equal(routeCreateResponse.status, 201);
    assert.equal(routeCreatePayload.route.pattern, "admin.alpha.example/*");
    assert.equal(routeCreatePayload.route.script, "hello-worker");

    const preferredResponse = await fetch(
      `http://127.0.0.1:${panelPort}/api/workers/hello-worker/preferred-route`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zoneId,
          zoneName: "alpha.example",
          pattern: "fangwen.alpha.example/*",
          preferredHostname: "saas.sin.fan",
        }),
      }
    );
    const preferredPayload = await preferredResponse.json();
    assert.equal(preferredResponse.status, 201);
    assert.equal(preferredPayload.deployment.routePattern, "fangwen.alpha.example/*");
    assert.equal(preferredPayload.deployment.route.script, "hello-worker");
    assert.equal(preferredPayload.deployment.dnsRecord.type, "CNAME");
    assert.equal(preferredPayload.deployment.dnsRecord.name, "fangwen.alpha.example");
    assert.equal(preferredPayload.deployment.dnsRecord.content, "saas.sin.fan");
    assert.equal(preferredPayload.deployment.dnsRecord.proxied, false);

    const domainCreateResponse = await fetch(
      `http://127.0.0.1:${panelPort}/api/workers/hello-worker/domains`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, zoneId, zoneName: "alpha.example", hostname: "app" }),
      }
    );
    const domainCreatePayload = await domainCreateResponse.json();
    assert.equal(domainCreateResponse.status, 201);
    assert.equal(domainCreatePayload.domain.hostname, "app.alpha.example");

    const subdomainResponse = await fetch(
      `http://127.0.0.1:${panelPort}/api/workers/hello-worker/subdomain`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, enabled: false }),
      }
    );
    const subdomainPayload = await subdomainResponse.json();
    assert.equal(subdomainResponse.status, 200);
    assert.equal(subdomainPayload.subdomain.enabled, false);

    const routeDeleteResponse = await fetch(
      `http://127.0.0.1:${panelPort}/api/workers/hello-worker/routes/route-1?zoneId=${zoneId}`,
      { method: "DELETE" }
    );
    assert.equal(routeDeleteResponse.status, 200);

    const domainDeleteResponse = await fetch(
      `http://127.0.0.1:${panelPort}/api/workers/hello-worker/domains/domain-1?accountId=${accountId}`,
      { method: "DELETE" }
    );
    assert.equal(domainDeleteResponse.status, 200);

    const workerDeleteResponse = await fetch(
      `http://127.0.0.1:${panelPort}/api/workers/hello-worker?accountId=${accountId}`,
      { method: "DELETE" }
    );
    assert.equal(workerDeleteResponse.status, 200);

    assert.deepEqual(
      requests
        .filter((request) => request.method !== "GET" || !request.path.endsWith("/accounts"))
        .map((request) => [request.method, request.path]),
      [
        ["GET", `/accounts/${accountId}/workers/scripts`],
        ["GET", `/accounts/${accountId}/workers/domains`],
        ["GET", `/accounts/${accountId}/workers/scripts/hello-worker`],
        ["GET", `/accounts/${accountId}/workers/scripts/hello-worker/subdomain`],
        ["GET", `/accounts/${accountId}/workers/scripts/hello-worker/settings`],
        ["GET", `/accounts/${accountId}/workers/domains`],
        ["GET", `/accounts/${accountId}/workers/scripts/hello-worker/schedules`],
        ["GET", `/accounts/${accountId}/workers/scripts/hello-worker/deployments`],
        ["GET", `/accounts/${accountId}/workers/scripts/hello-worker/secrets`],
        ["GET", `/accounts/${accountId}/queues`],
        ["PUT", `/accounts/${accountId}/workers/scripts/hello-worker`],
        ["GET", `/zones/${zoneId}/workers/routes`],
        ["POST", `/zones/${zoneId}/workers/routes`],
        ["GET", `/zones/${zoneId}/workers/routes`],
        ["POST", `/zones/${zoneId}/workers/routes`],
        ["GET", `/zones/${zoneId}/dns_records`],
        ["POST", `/zones/${zoneId}/dns_records`],
        ["PUT", `/accounts/${accountId}/workers/domains`],
        ["POST", `/accounts/${accountId}/workers/scripts/hello-worker/subdomain`],
        ["DELETE", `/zones/${zoneId}/workers/routes/route-1`],
        ["DELETE", `/accounts/${accountId}/workers/domains/domain-1`],
        ["DELETE", `/accounts/${accountId}/workers/scripts/hello-worker`],
      ]
    );
  } finally {
    await panel.stop();
    cloudflareMock.close();
  }
});

test("adds Worker preferred route with DNS CNAME disabled proxy", async () => {
  const accountId = "1".repeat(32);
  const zoneId = "a".repeat(32);
  const requests = [];
  const cloudflareMock = createWorkersMock({ accountId, zoneId, requests });
  const mockUrl = await listen(cloudflareMock);
  const panelPort = 3232;
  const panel = startPanel({
    PORT: String(panelPort),
    CLOUDFLARE_EMAIL: "admin@example.com",
    CLOUDFLARE_GLOBAL_API_KEY: "global-key",
    CLOUDFLARE_API_BASE_URL: mockUrl,
  });

  try {
    await waitForHttp(`http://127.0.0.1:${panelPort}/`);

    const response = await fetch(
      `http://127.0.0.1:${panelPort}/api/workers/hello-worker/preferred-route`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zoneId,
          zoneName: "alpha.example",
          pattern: "fangwen.alpha.example/*",
          preferredHostname: "saas.sin.fan",
        }),
      }
    );
    const payload = await response.json();

    assert.equal(response.status, 201);
    assert.equal(payload.deployment.accessHostname, "fangwen.alpha.example");
    assert.equal(payload.deployment.preferredHostname, "saas.sin.fan");

    const routeRequest = requests.find(
      (request) =>
        request.method === "POST" && request.path === `/zones/${zoneId}/workers/routes`
    );
    assert.deepEqual(routeRequest.body, {
      pattern: "fangwen.alpha.example/*",
      script: "hello-worker",
    });

    const dnsRequest = requests.find(
      (request) =>
        request.method === "POST" && request.path === `/zones/${zoneId}/dns_records`
    );
    assert.deepEqual(dnsRequest.body, {
      type: "CNAME",
      name: "fangwen.alpha.example",
      content: "saas.sin.fan",
      ttl: 1,
      proxied: false,
      comment: "Worker 优选域名",
    });
  } finally {
    await panel.stop();
    cloudflareMock.close();
  }
});

test("rejects Worker route patterns outside the selected zone", async () => {
  const accountId = "1".repeat(32);
  const zoneId = "a".repeat(32);
  const requests = [];
  const cloudflareMock = createWorkersMock({ accountId, zoneId, requests });
  const mockUrl = await listen(cloudflareMock);
  const panelPort = 3231;
  const panel = startPanel({
    PORT: String(panelPort),
    CLOUDFLARE_EMAIL: "admin@example.com",
    CLOUDFLARE_GLOBAL_API_KEY: "global-key",
    CLOUDFLARE_API_BASE_URL: mockUrl,
  });

  try {
    await waitForHttp(`http://127.0.0.1:${panelPort}/`);

    const response = await fetch(
      `http://127.0.0.1:${panelPort}/api/workers/hello-worker/routes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zoneId,
          zoneName: "alpha.example",
          pattern: "api.other.example/*",
        }),
      }
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.match(payload.error, /必须属于所选区域 alpha\.example/);
    assert.equal(
      requests.some(
        (request) =>
          request.method === "POST" && request.path === `/zones/${zoneId}/workers/routes`
      ),
      false
    );
  } finally {
    await panel.stop();
    cloudflareMock.close();
  }
});

test("rejects Worker preferred route outside the selected zone before Cloudflare writes", async () => {
  const accountId = "1".repeat(32);
  const zoneId = "a".repeat(32);
  const requests = [];
  const cloudflareMock = createWorkersMock({ accountId, zoneId, requests });
  const mockUrl = await listen(cloudflareMock);
  const panelPort = 3233;
  const panel = startPanel({
    PORT: String(panelPort),
    CLOUDFLARE_EMAIL: "admin@example.com",
    CLOUDFLARE_GLOBAL_API_KEY: "global-key",
    CLOUDFLARE_API_BASE_URL: mockUrl,
  });

  try {
    await waitForHttp(`http://127.0.0.1:${panelPort}/`);

    const response = await fetch(
      `http://127.0.0.1:${panelPort}/api/workers/hello-worker/preferred-route`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zoneId,
          zoneName: "alpha.example",
          pattern: "fangwen.other.example/*",
          preferredHostname: "saas.sin.fan",
        }),
      }
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.match(payload.error, /必须属于所选区域 alpha\.example/);
    assert.equal(
      requests.some(
        (request) =>
          request.method === "POST" && request.path === `/zones/${zoneId}/workers/routes`
      ),
      false
    );
    assert.equal(
      requests.some(
        (request) =>
          request.method === "POST" && request.path === `/zones/${zoneId}/dns_records`
      ),
      false
    );
  } finally {
    await panel.stop();
    cloudflareMock.close();
  }
});

test("rolls back a newly created Worker preferred route when DNS conflicts", async () => {
  const accountId = "1".repeat(32);
  const zoneId = "a".repeat(32);
  const requests = [];
  const cloudflareMock = createWorkersMock({
    accountId,
    zoneId,
    requests,
    dnsRecords: [
      {
        id: "d".repeat(32),
        type: "A",
        name: "fangwen.alpha.example",
        content: "192.0.2.1",
        ttl: 1,
      },
    ],
  });
  const mockUrl = await listen(cloudflareMock);
  const panelPort = 3234;
  const panel = startPanel({
    PORT: String(panelPort),
    CLOUDFLARE_EMAIL: "admin@example.com",
    CLOUDFLARE_GLOBAL_API_KEY: "global-key",
    CLOUDFLARE_API_BASE_URL: mockUrl,
  });

  try {
    await waitForHttp(`http://127.0.0.1:${panelPort}/`);

    const response = await fetch(
      `http://127.0.0.1:${panelPort}/api/workers/hello-worker/preferred-route`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zoneId,
          zoneName: "alpha.example",
          pattern: "fangwen.alpha.example/*",
          preferredHostname: "saas.sin.fan",
        }),
      }
    );
    const payload = await response.json();

    assert.equal(response.status, 409);
    assert.match(payload.error, /已存在 A 解析/);
    assert.equal(
      requests.some(
        (request) =>
          request.method === "POST" && request.path === `/zones/${zoneId}/workers/routes`
      ),
      true
    );
    assert.equal(
      requests.some(
        (request) =>
          request.method === "DELETE" &&
          request.path === `/zones/${zoneId}/workers/routes/route-3`
      ),
      true
    );
  } finally {
    await panel.stop();
    cloudflareMock.close();
  }
});

test("renders Workers view with original-style modal text and compact domain manager", async () => {
  const [{ state, resetWorkersState }, { renderWorkersView }] = await Promise.all([
    import("../public/js/state.js"),
    import("../public/js/views/workers-view.js"),
  ]);

  const app = { className: "", innerHTML: "" };
  global.document = {
    querySelector(selector) {
      assert.equal(selector, "#app");
      return app;
    },
  };

  resetWorkersState();
  state.connected = true;
  state.mainSection = "workers";
  state.view = "domains";
  state.sessionEmail = "admin@example.com";
  state.zones = [{ id: "a".repeat(32), name: "alpha.example" }];
  state.workersAccountId = "1".repeat(32);
  state.workersAccounts = [{ id: "1".repeat(32), name: "Test Account" }];
  state.workersLoaded = true;
  state.workersList = [
    {
      id: "hello-worker",
      name: "hello-worker",
      etag: "abc123",
      usageModel: "standard",
      modifiedOn: "2026-01-01T00:00:00Z",
    },
  ];
  state.workersDomains = [
    {
      id: "domain-1",
      hostname: "api.alpha.example",
      service: "hello-worker",
      zoneName: "alpha.example",
    },
  ];
  state.workersModal = "edit";
  state.workersActiveName = "hello-worker";
  state.workersActiveTab = "domain";
  state.workersActiveDetail = {
    worker: { name: "hello-worker" },
    subdomain: { enabled: true, previewsEnabled: true },
    domains: state.workersDomains,
    settings: { bindings: [{ name: "KV_CACHE", type: "kv_namespace" }] },
  };
  state.workersRoutes = [
    { id: "route-1", pattern: "api.alpha.example/*", script: "hello-worker" },
  ];

  renderWorkersView();

  assert.match(app.innerHTML, /Workers/);
  assert.match(app.innerHTML, /新建 Worker/);
  assert.match(app.innerHTML, /编辑 Worker: hello-worker/);
  assert.match(app.innerHTML, /代码编辑/);
  assert.match(app.innerHTML, /域名管理/);
  assert.match(app.innerHTML, /Workers\.dev 子域/);
  assert.match(app.innerHTML, /Worker 优选/);
  assert.match(app.innerHTML, /saas\.sin\.fan/);
  assert.match(app.innerHTML, /路由模式/);
  assert.match(app.innerHTML, /自定义域/);
  assert.match(app.innerHTML, /KV_CACHE/);
});
