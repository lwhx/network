import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allocatePanelPort,
  preparePanelTestEnvironment,
} from "./helpers/panel-test-environment.js";

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

  return {
    child,
    async stop() {
      child.kill();
      await once(child, "exit").catch(() => {});
      prepared.cleanup();
    },
  };
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function cf(result, resultInfo) {
  return {
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo ? { result_info: resultInfo } : {}),
  };
}

function makeRecord(overrides = {}) {
  return {
    id: "b".repeat(32),
    type: "CNAME",
    name: "cdn.alpha.example",
    content: "saas.sin.fan",
    ttl: 1,
    proxied: false,
    proxiable: true,
    comment: "一键加速优选域名",
    tags: [],
    created_on: "2026-01-01T00:00:00Z",
    modified_on: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function createAdvancedMock({ zoneId, requests }) {
  const deletedPaths = new Set();
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const body = await readJsonBody(request).catch(() => null);
    requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
    });

    const settingMatch = url.pathname.match(
      new RegExp(`^/zones/${zoneId}/settings/(?<settingId>[a-z0-9_]+)$`)
    );

    if (request.method === "GET" && settingMatch) {
      const values = {
        ssl: "strict",
        always_use_https: "off",
        automatic_https_rewrites: "on",
        min_tls_version: "1.2",
        tls_1_3: "on",
        opportunistic_encryption: "off",
        websockets: "on",
        http3: "on",
      };
      json(response, 200, cf({
        id: settingMatch.groups.settingId,
        value: values[settingMatch.groups.settingId] || "off",
        editable: true,
      }));
      return;
    }

    if (request.method === "PATCH" && settingMatch) {
      json(response, 200, cf({
        id: settingMatch.groups.settingId,
        value: body.value,
        editable: true,
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === `/zones/${zoneId}/ssl/universal/settings`) {
      json(response, 200, cf({ enabled: true, value: "auto", editable: true }));
      return;
    }

    if (request.method === "GET" && url.pathname === `/zones/${zoneId}/custom_certificates`) {
      json(response, 200, cf([], { page: 1, per_page: 50, total_pages: 1, total_count: 0 }));
      return;
    }

    if (request.method === "POST" && url.pathname === `/zones/${zoneId}/custom_certificates`) {
      assert.match(body.certificate, /BEGIN CERTIFICATE/);
      assert.match(body.private_key, /BEGIN PRIVATE KEY/);
      json(response, 200, cf({
        id: "custom-cert-1",
        hosts: ["alpha.example"],
        status: "active",
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/certificates") {
      json(response, 200, cf([], { page: 1, per_page: 50, total_pages: 1, total_count: 0 }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/certificates") {
      assert.equal(body.zone_id, zoneId);
      assert.deepEqual(body.hostnames, ["alpha.example"]);
      json(response, 200, cf({
        id: "origin-cert-1",
        certificate: "-----BEGIN CERTIFICATE-----\norigin\n-----END CERTIFICATE-----",
        hostnames: body.hostnames,
        request_type: body.request_type,
      }));
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === `/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`
    ) {
      json(response, 200, cf({
        id: "ruleset-1",
        phase: "http_request_firewall_custom",
        rules: [],
      }));
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === `/zones/${zoneId}/rulesets/phases/http_ratelimit/entrypoint`
    ) {
      json(response, 404, {
        success: false,
        errors: [{ message: "not found" }],
        messages: [],
      });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === `/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint/rules`
    ) {
      json(response, 200, cf({
        id: "ruleset-rule-1",
        ...body,
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === `/zones/${zoneId}`) {
      json(response, 200, cf({ id: zoneId, name: "alpha.example" }));
      return;
    }

    if (request.method === "GET" && url.pathname === `/zones/${zoneId}/dns_records`) {
      const items = [
          makeRecord(),
          makeRecord({
            id: "c".repeat(32),
            type: "A",
            name: "saas.alpha.example",
            content: "6.6.6.6",
            proxied: true,
            comment: "一键加速回退源",
          }),
        ].filter(record => !deletedPaths.has(`/zones/${zoneId}/dns_records/${record.id}`));
      json(response, 200, cf(items,
        { page: 1, per_page: 100, total_pages: 1, total_count: items.length }
      ));
      return;
    }

    if (request.method === "GET" && url.pathname === `/zones/${zoneId}/custom_hostnames`) {
      const items = [
          {
            id: "custom-hostname-1",
            hostname: "cdn.alpha.example",
            custom_origin_server: "origin.alpha.example",
            status: "active",
            ssl: { status: "active", method: "http" },
          },
        ].filter(hostname => !deletedPaths.has(`/zones/${zoneId}/custom_hostnames/${hostname.id}`));
      json(response, 200, cf(items,
        { page: 1, per_page: 50, total_pages: 1, total_count: items.length }
      ));
      return;
    }

    if (
      request.method === "DELETE" &&
      (url.pathname === `/zones/${zoneId}/dns_records/${"b".repeat(32)}` ||
        url.pathname === `/zones/${zoneId}/custom_hostnames/custom-hostname-1`)
    ) {
      deletedPaths.add(url.pathname);
      response.writeHead(204);
      response.end();
      return;
    }

    json(response, 404, {
      success: false,
      errors: [{ message: `${request.method} ${url.pathname} not mocked` }],
      messages: [],
    });
  });
}

test("manages SSL settings, certificates, rulesets, and accelerated domain inventory", async () => {
  const zoneId = "a".repeat(32);
  const requests = [];
  const cloudflareMock = createAdvancedMock({ zoneId, requests });
  const mockUrl = await listen(cloudflareMock);
  const panelPort = await allocatePanelPort();
  const panel = startPanel({
    PORT: String(panelPort),
    CLOUDFLARE_EMAIL: "admin@example.com",
    CLOUDFLARE_GLOBAL_API_KEY: "global-key",
    CLOUDFLARE_API_BASE_URL: mockUrl,
  });

  try {
    await waitForHttp(`http://127.0.0.1:${panelPort}/`);

    const sslResponse = await fetch(`http://127.0.0.1:${panelPort}/api/zones/${zoneId}/ssl-settings`);
    const sslPayload = await sslResponse.json();
    assert.equal(sslResponse.status, 200);
    assert.equal(sslPayload.ssl.settings.ssl.value, "strict");
    assert.equal(sslPayload.ssl.settings.alwaysUseHttps.value, false);

    const sslPatchResponse = await fetch(`http://127.0.0.1:${panelPort}/api/zones/${zoneId}/ssl-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssl: "strict", alwaysUseHttps: true }),
    });
    assert.equal(sslPatchResponse.status, 200);

    const certStateResponse = await fetch(`http://127.0.0.1:${panelPort}/api/zones/${zoneId}/certificates`);
    const certStatePayload = await certStateResponse.json();
    assert.equal(certStateResponse.status, 200);
    assert.equal(certStatePayload.universalSsl.enabled, true);

    const uploadResponse = await fetch(`http://127.0.0.1:${panelPort}/api/zones/${zoneId}/certificates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        certificate: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
        privateKey: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
      }),
    });
    assert.equal(uploadResponse.status, 201);

    const originResponse = await fetch(`http://127.0.0.1:${panelPort}/api/zones/${zoneId}/origin-certificates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostnames: "alpha.example", requestType: "origin-rsa" }),
    });
    const originPayload = await originResponse.json();
    assert.equal(originResponse.status, 201);
    assert.match(originPayload.certificate.certificate, /BEGIN CERTIFICATE/);

    const rulesResponse = await fetch(`http://127.0.0.1:${panelPort}/api/zones/${zoneId}/firewall-rulesets/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phase: "http_request_firewall_custom",
        action: "block",
        description: "Block bad bot",
        expression: 'http.user_agent contains "bad"',
      }),
    });
    assert.equal(rulesResponse.status, 201);

    const speedListResponse = await fetch(`http://127.0.0.1:${panelPort}/api/zones/${zoneId}/speed-deploy`);
    const speedListPayload = await speedListResponse.json();
    assert.equal(speedListResponse.status, 200);
    assert.equal(speedListPayload.speed.domains[0].accessDomain, "cdn.alpha.example");
    assert.equal(speedListPayload.speed.domains[0].targetDomain, "origin.alpha.example");

    const speedDeleteResponse = await fetch(
      `http://127.0.0.1:${panelPort}/api/zones/${zoneId}/speed-deploy/cdn.alpha.example`,
      { method: "DELETE" }
    );
    assert.equal(speedDeleteResponse.status, 200);

    assert.ok(
      requests.some(
        (request) =>
          request.method === "PATCH" &&
          request.path === `/zones/${zoneId}/settings/ssl` &&
          request.body.value === "strict"
      )
    );
    assert.ok(
      requests.some(
        (request) =>
          request.method === "POST" &&
          request.path === `/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint/rules`
      )
    );
    assert.ok(
      requests.some(
        (request) =>
          request.method === "DELETE" &&
          request.path === `/zones/${zoneId}/custom_hostnames/custom-hostname-1`
      )
    );
  } finally {
    await panel.stop();
    cloudflareMock.close();
  }
});
