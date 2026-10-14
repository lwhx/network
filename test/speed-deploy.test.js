import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createSpeedCloudflareMock } from "./helpers/speed-cloudflare-mock.js";

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

  return {
    child,
    async stop() {
      child.kill();
      await once(child, "exit").catch(() => {});
      prepared.cleanup();
    },
  };
}

function makeDnsRecord(overrides = {}) {
  return {
    id: "b".repeat(32),
    type: "A",
    name: "saas.alpha.example",
    content: "6.6.6.6",
    ttl: 1,
    proxied: true,
    proxiable: true,
    comment: "一键加速回退源",
    tags: [],
    created_on: "2026-01-01T00:00:00Z",
    modified_on: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCustomHostname(overrides = {}) {
  return {
    id: "custom-hostname-01",
    hostname: "cdn.alpha.example",
    custom_origin_server: "origin.alpha.example",
    status: "pending",
    ssl: {
      method: "http",
      status: "pending_validation",
      type: "dv",
    },
    ...overrides,
  };
}

const createCloudflareMock = createSpeedCloudflareMock;

async function postSpeedDeploy(panelPort, zoneId, body) {
  const response = await fetch(
    `http://127.0.0.1:${panelPort}/api/zones/${zoneId}/speed-deploy`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const payload = await response.json();

  return { payload, response };
}

test("deploys one-click acceleration through Cloudflare SaaS APIs", async () => {
  const zoneId = "a".repeat(32);
  const cloudflareMock = createCloudflareMock({
    dnsRecords: [
      makeDnsRecord({
        id: "d".repeat(32),
        type: "A",
        name: "origin.alpha.example",
        content: "192.0.2.10",
        proxied: false,
        comment: "",
      }),
    ],
  });
  const mockUrl = await listen(cloudflareMock.server);
  const panelPort = 3260;
  const panel = startPanel({
    PORT: String(panelPort),
    CLOUDFLARE_EMAIL: "admin@example.com",
    CLOUDFLARE_GLOBAL_API_KEY: "global-key",
    CLOUDFLARE_API_BASE_URL: mockUrl,
  });

  try {
    await waitForHttp(`http://127.0.0.1:${panelPort}/`);

    const { payload, response } = await postSpeedDeploy(panelPort, zoneId, {
      accessDomain: "cdn.alpha.example",
      targetDomain: "origin.alpha.example",
      cacheTtl: "0",
      optimizedDomain: "saas.sin.fan",
      zoneName: "alpha.example",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.deployment.accessDomain, "cdn.alpha.example");
    assert.equal(payload.deployment.accessRecord.name, "cdn.alpha.example");
    assert.equal(payload.deployment.accessRecord.content, "saas.sin.fan");
    assert.equal(payload.deployment.fallbackRecord.name, "saas.alpha.example");
    assert.equal(payload.deployment.fallbackOrigin.origin, "saas.alpha.example");
    assert.equal(payload.deployment.sslSetting.value, "flexible");
    assert.equal(payload.deployment.sslSetting.changed, false);
    assert.equal(cloudflareMock.state.ssl, "flexible");

    const writes = cloudflareMock.requests.filter((call) => call.method !== "GET");
    assert.deepEqual(writes.map((call) => [call.method, call.path]), [
      ["POST", `/zones/${zoneId}/dns_records`],
      ["PUT", `/zones/${zoneId}/custom_hostnames/fallback_origin`],
      ["POST", `/zones/${zoneId}/custom_hostnames`],
      ["POST", `/zones/${zoneId}/dns_records`],
    ]);
    assert.deepEqual(writes[0].body, {
      type: "A", name: "saas.alpha.example", content: "6.6.6.6",
      ttl: 1, proxied: true, comment: "一键加速回退源",
    });
    assert.deepEqual(writes[1].body, { origin: "saas.alpha.example" });
    assert.deepEqual(writes[2].body, {
      hostname: "cdn.alpha.example", custom_origin_server: "origin.alpha.example",
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
    });
    assert.deepEqual(writes[3].body, {
      type: "CNAME", name: "cdn.alpha.example", content: "saas.sin.fan",
      ttl: 1, proxied: false, comment: "一键加速优选域名",
    });

  } finally {
    await panel.stop();
    cloudflareMock.server.close();
  }
});

test("updates managed fallback DNS and existing custom hostname idempotently", async () => {
  const zoneId = "a".repeat(32);
  const fallbackRecordId = "b".repeat(32);
  const customHostnameId = "existing-hostname-01";
  const cloudflareMock = createCloudflareMock({
    customHostnames: [
      makeCustomHostname({
        id: customHostnameId,
        hostname: "cdn.alpha.example",
        custom_origin_server: "old-origin.alpha.example",
      }),
    ],
    dnsRecords: [
      makeDnsRecord({
        id: "1".repeat(32),
        type: "A",
        name: "origin.alpha.example",
        content: "192.0.2.10",
        proxied: false,
        comment: "",
      }),
      makeDnsRecord({
        id: "2".repeat(32),
        type: "CNAME",
        name: "cdn.alpha.example",
        content: "old-target.example",
        proxied: true,
        comment: "",
      }),
      makeDnsRecord({
        id: fallbackRecordId,
        proxied: false,
        comment: "",
      }),
    ],
  });
  const mockUrl = await listen(cloudflareMock.server);
  const panelPort = 3221;
  const panel = startPanel({
    PORT: String(panelPort),
    CLOUDFLARE_EMAIL: "admin@example.com",
    CLOUDFLARE_GLOBAL_API_KEY: "global-key",
    CLOUDFLARE_API_BASE_URL: mockUrl,
  });

  try {
    await waitForHttp(`http://127.0.0.1:${panelPort}/`);

    const { payload, response } = await postSpeedDeploy(panelPort, zoneId, {
      accessDomain: "cdn.alpha.example",
      targetDomain: "origin.alpha.example",
      cacheTtl: "120",
      optimizedDomain: "saas.sin.fan",
      zoneName: "alpha.example",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.deployment.accessRecord.content, "saas.sin.fan");
    assert.equal(payload.deployment.accessRecord.proxied, false);
    assert.equal(payload.deployment.fallbackRecord.proxied, true);
    assert.equal(payload.deployment.customHostname.customOriginServer, "origin.alpha.example");

    const writes = cloudflareMock.requests.filter((call) => call.method !== "GET");
    assert.deepEqual(writes.map((call) => [call.method, call.path]), [
      ["PATCH", `/zones/${zoneId}/dns_records/${fallbackRecordId}`],
      ["PUT", `/zones/${zoneId}/custom_hostnames/fallback_origin`],
      ["PATCH", `/zones/${zoneId}/custom_hostnames/${customHostnameId}`],
      ["PATCH", `/zones/${zoneId}/dns_records/${"2".repeat(32)}`],
    ]);
    assert.deepEqual(writes[2].body, { custom_origin_server: "origin.alpha.example" });
    assert.equal(cloudflareMock.state.ssl, "flexible");

  } finally {
    await panel.stop();
    cloudflareMock.server.close();
  }
});

test("allows a custom optimized domain outside the recommended list", async () => {
  const zoneId = "a".repeat(32);
  const cloudflareMock = createCloudflareMock({
    dnsRecords: [
      makeDnsRecord({
        id: "d".repeat(32),
        type: "A",
        name: "origin.alpha.example",
        content: "192.0.2.10",
        proxied: false,
        comment: "",
      }),
    ],
  });
  const mockUrl = await listen(cloudflareMock.server);
  const panelPort = 3227;
  const panel = startPanel({
    PORT: String(panelPort),
    CLOUDFLARE_EMAIL: "admin@example.com",
    CLOUDFLARE_GLOBAL_API_KEY: "global-key",
    CLOUDFLARE_API_BASE_URL: mockUrl,
  });

  try {
    await waitForHttp(`http://127.0.0.1:${panelPort}/`);

    const { payload, response } = await postSpeedDeploy(panelPort, zoneId, {
      accessDomain: "cdn.alpha.example",
      targetDomain: "origin.alpha.example",
      cacheTtl: "0",
      optimizedDomain: "custom.optimized.example",
      zoneName: "alpha.example",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.deployment.optimizedDomain, "custom.optimized.example");
    assert.deepEqual(cloudflareMock.requests.find((call) => call.method === "POST" && call.body?.name === "cdn.alpha.example").body, {
      type: "CNAME",
      name: "cdn.alpha.example",
      content: "custom.optimized.example",
      ttl: 1,
      proxied: false,
      comment: "一键加速优选域名",
    });
  } finally {
    await panel.stop();
    cloudflareMock.server.close();
  }
});

test("renders saas.sin.fan as default and exposes custom optimized domain input", async () => {
  const [{ state }, { renderSpeedView }] = await Promise.all([
    import("../public/js/state.js"),
    import("../public/js/views/speed-view.js"),
  ]);
  const app = {
    className: "",
    innerHTML: "",
  };

  global.document = {
    querySelector(selector) {
      assert.equal(selector, "#app");
      return app;
    },
  };

  state.connected = true;
  state.mainSection = "speed";
  state.view = "domains";
  state.speedStep = "domains";
  state.speedForm = {
    accessDomain: "",
    targetDomain: "",
    cacheTtl: "0",
    optimizedDomain: "saas.sin.fan",
    optimizedDomainCustom: "",
  };

  renderSpeedView();

  assert.match(app.innerHTML, /saas\.sin\.fan 推荐/);
  assert.match(app.innerHTML, /自定义优选域名/);
  assert.match(app.innerHTML, /填写后会覆盖上方推荐选项/);
  assert.match(app.innerHTML, /沿用当前域名区域的 SSL\/TLS 模式/);
  assert.match(app.innerHTML, /部署失败时会尝试恢复/);

  delete global.document;
});

test("warns when an in-zone source domain has no DNS record", async () => {
  const zoneId = "a".repeat(32);
  const cloudflareMock = createCloudflareMock();
  const mockUrl = await listen(cloudflareMock.server);
  const panelPort = 3223;
  const panel = startPanel({
    PORT: String(panelPort),
    CLOUDFLARE_EMAIL: "admin@example.com",
    CLOUDFLARE_GLOBAL_API_KEY: "global-key",
    CLOUDFLARE_API_BASE_URL: mockUrl,
  });

  try {
    await waitForHttp(`http://127.0.0.1:${panelPort}/`);

    const { payload, response } = await postSpeedDeploy(panelPort, zoneId, {
      accessDomain: "cdn.alpha.example",
      targetDomain: "origin.alpha.example",
      cacheTtl: "0",
      optimizedDomain: "cdn.cnno.de",
      zoneName: "alpha.example",
    });

    assert.equal(response.status, 409);
    assert.match(payload.error, /源站域名 origin\.alpha\.example 未添加 DNS 解析/);
    assert.ok(cloudflareMock.requests.every((call) => call.method === "GET"));

  } finally {
    await panel.stop();
    cloudflareMock.server.close();
  }
});

test("rejects one-click acceleration when the access domain is outside the zone", async () => {
  const zoneId = "a".repeat(32);
  const cloudflareMock = createCloudflareMock();
  const mockUrl = await listen(cloudflareMock.server);
  const panelPort = 3222;
  const panel = startPanel({
    PORT: String(panelPort),
    CLOUDFLARE_EMAIL: "admin@example.com",
    CLOUDFLARE_GLOBAL_API_KEY: "global-key",
    CLOUDFLARE_API_BASE_URL: mockUrl,
  });

  try {
    await waitForHttp(`http://127.0.0.1:${panelPort}/`);

    const { payload, response } = await postSpeedDeploy(panelPort, zoneId, {
      accessDomain: "cdn.other.example",
      targetDomain: "origin.alpha.example",
      cacheTtl: "0",
      optimizedDomain: "saas.sin.fan",
      zoneName: "alpha.example",
    });

    assert.equal(response.status, 400);
    assert.match(payload.error, /访问域名必须属于 alpha\.example/);
    assert.equal(cloudflareMock.requests.length, 0);
  } finally {
    await panel.stop();
    cloudflareMock.server.close();
  }
});


test("speed deployment API retains an unconfirmed traffic switch for manual recovery", async () => {
  const zoneId = "a".repeat(32);
  let failed = false;
  const cloudflareMock = createCloudflareMock({
    dnsRecords: [makeDnsRecord({ id: "d".repeat(32), type: "A", name: "origin.alpha.example",
      content: "192.0.2.10", proxied: false, comment: "" })],
    intercept({ call, apply, send }) {
      if (failed || call.method !== "POST" || call.body?.name !== "cdn.alpha.example") return false;
      failed = true;
      apply();
      send(null, 502);
      return true;
    },
  });
  const mockUrl = await listen(cloudflareMock.server);
  const before = structuredClone(cloudflareMock.state);
  const panel = startPanel({ PORT: "3261", CLOUDFLARE_EMAIL: "admin@example.com",
    CLOUDFLARE_GLOBAL_API_KEY: "global-key", CLOUDFLARE_API_BASE_URL: mockUrl });
  try {
    await waitForHttp("http://127.0.0.1:3261/");
    const { response, payload } = await postSpeedDeploy(3261, zoneId, {
      accessDomain: "cdn.alpha.example", targetDomain: "origin.alpha.example",
      optimizedDomain: "saas.sin.fan", zoneName: "alpha.example", cacheTtl: 0,
    });
    assert.equal(response.status, 502);
    assert.equal(payload.rollback.status, "incomplete");
    assert.ok(payload.taskId);
    assert.match(payload.error, /恢复未完成/);
    assert.equal(cloudflareMock.state.dnsRecords.length, before.dnsRecords.length + 1);
    assert.equal(cloudflareMock.state.dnsRecords.at(-1).name, "cdn.alpha.example");
    assert.deepEqual(cloudflareMock.state.customHostnames, before.customHostnames);
    assert.equal(cloudflareMock.state.fallbackOrigin, before.fallbackOrigin);
    assert.ok(payload.rollback.steps.some(step => step.resource === "访问域名 DNS" && step.status === "failed"));
    assert.ok(payload.rollback.steps.some(step => step.resource === "回退源 DNS" && step.status === "restored"));
  } finally {
    await panel.stop();
    cloudflareMock.server.close();
  }
});
