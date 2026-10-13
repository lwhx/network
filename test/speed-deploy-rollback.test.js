import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudflareClient } from "../src/services/cloudflare/cloudflare-client.js";
import { DnsRecordsService } from "../src/services/cloudflare/dns-records-service.js";
import { SpeedDeployService } from "../src/services/cloudflare/speed-deploy-service.js";
import { createSpeedCloudflareMock } from "./helpers/speed-cloudflare-mock.js";

const zoneId = "a".repeat(32);
const base = `/zones/${zoneId}`;
const input = { zoneName: "alpha.example", accessDomain: "cdn.alpha.example",
  targetDomain: "origin.alpha.example", optimizedDomain: "saas.sin.fan", cacheTtl: 0 };
const origin = { id: "d".repeat(32), type: "A", name: input.targetDomain,
  content: "192.0.2.10", ttl: 300, proxied: false, comment: "source", tags: [] };
const access = { id: "e".repeat(32), type: "CNAME", name: input.accessDomain,
  content: "old.example", ttl: 600, proxied: true, comment: "keep me", tags: ["owner:me"],
  settings: { flatten_cname: true } };
const fallback = { id: "f".repeat(32), type: "A", name: "saas.alpha.example",
  content: "6.6.6.6", ttl: 300, proxied: false, comment: "existing", tags: ["owner:me"],
  settings: { ipv4_only: true, ipv6_only: false } };
const hostname = { id: "existing-hostname", hostname: input.accessDomain,
  custom_origin_server: "old-origin.alpha.example", custom_origin_sni: "custom-sni.example",
  custom_metadata: { owner: "me" }, ssl: { method: "txt", type: "dv",
    settings: { min_tls_version: "1.3", http2: "on" } } };

async function environment(t, { requestTimeoutMs = 1500, ...options } = {}) {
  const mock = createSpeedCloudflareMock({ dnsRecords: [origin], ...options });
  mock.server.listen(0, "127.0.0.1");
  await once(mock.server, "listening");
  t.after(() => { mock.server.closeAllConnections(); mock.server.close(); });
  const client = new CloudflareClient({ apiBaseUrl: `http://127.0.0.1:${mock.server.address().port}`,
    email: "demo@example.com", globalApiKey: "demo-key", requestTimeoutMs });
  const service = new SpeedDeployService({ cloudflareClient: client,
    dnsRecordsService: new DnsRecordsService({ cloudflareClient: client }) });
  return { ...mock, client, service };
}

test("acceleration preserves every existing Zone SSL mode", async (t) => {
  for (const ssl of ["off", "flexible", "full", "strict", "origin_pull"]) {
    await t.test(ssl, async (t) => {
      const env = await environment(t, { ssl });
      const result = await env.service.deploy(zoneId, input);
      assert.equal(env.state.ssl, ssl);
      assert.equal(result.sslSetting.value, ssl);
      assert.equal(result.sslSetting.changed, false);
      assert.ok(env.requests.every((call) => !call.path.endsWith("/settings/ssl") || call.method === "GET"));
    });
  }
});

test("deployment preserves existing hostname certificate and metadata settings", async (t) => {
  const env = await environment(t, { customHostnames: [hostname] });
  await env.service.deploy(zoneId, input);
  assert.deepEqual(env.state.customHostnames[0], { ...hostname, custom_origin_server: input.targetDomain });
  const writes = env.requests.filter((call) => call.method !== "GET");
  assert.equal(writes.at(-1).body.name, input.accessDomain, "traffic switches only after SaaS configuration");
});

test("Cloudflare populated defaults do not make successful writes look like failures", async (t) => {
  const env = await environment(t, { intercept({ call, apply, send }) {
    if (call.method !== "POST") return false;
    const resource = apply();
    if (call.path.endsWith("/dns_records")) resource.settings = { ipv4_only: false, ipv6_only: false };
    if (call.path.endsWith("/custom_hostnames")) resource.ssl.settings.http2 = "on";
    send(resource);
    return true;
  } });
  await env.service.deploy(zoneId, input);
  assert.equal(env.state.customHostnames.length, 1);
  assert.equal(env.state.dnsRecords.length, 3);
  assert.equal(env.state.ssl, "flexible");
});

test("a lost response after creation is reconciled and rolled back", async (t) => {
  let disconnected = false;
  const env = await environment(t, { intercept({ call, apply, disconnect }) {
    if (disconnected || call.method !== "POST") return false;
    disconnected = true;
    apply();
    disconnect();
    return true;
  } });
  const before = structuredClone(env.state);
  await assert.rejects(env.service.deploy(zoneId, input), (error) => error.rollback.status === "complete");
  assert.deepEqual(env.state, before);
});

test("an unconfirmed timed-out write is reported as incomplete even if reads show the old state", async (t) => {
  let release, applied;
  const gate = new Promise((resolve) => { release = resolve; });
  const finished = new Promise((resolve) => { applied = resolve; });
  let delayed = false;
  const env = await environment(t, { requestTimeoutMs: 150, async intercept({ call, apply, send }) {
    if (delayed || call.method !== "POST") return false;
    delayed = true;
    await gate;
    send(apply());
    applied();
    return true;
  } });
  try {
    await assert.rejects(env.service.deploy(zoneId, input), (error) => {
      assert.equal(error.rollback.status, "incomplete");
      assert.match(error.message, /写入请求结果未确认/);
      return true;
    });
  } finally {
    release();
    await finished;
  }
});

const stages = [
  ["fallback DNS", (call) => call.method === "POST" && call.path.endsWith("/dns_records") && call.body.name === fallback.name],
  ["fallback origin", (call) => call.method === "PUT" && call.path.endsWith("/fallback_origin")],
  ["custom hostname", (call) => call.method === "POST" && call.path.endsWith("/custom_hostnames")],
  ["access DNS", (call) => call.method === "POST" && call.path.endsWith("/dns_records") && call.body.name === input.accessDomain],
];
for (const [stage, matches] of stages) {
  for (const applied of [false, true]) {
    test(`restores original state when ${stage} fails ${applied ? "after" : "before"} Cloudflare applies it`, async (t) => {
      let failed = false;
      const env = await environment(t, { intercept({ call, apply, send }) {
        if (failed || !matches(call)) return false;
        failed = true;
        if (applied) apply();
        send(null, applied ? 502 : 400);
        return true;
      } });
      const before = structuredClone(env.state);
      await assert.rejects(env.service.deploy(zoneId, input), (error) => {
        assert.equal(error.rollback.status, "complete");
        assert.match(error.message, /已恢复/);
        return true;
      });
      assert.deepEqual(env.state, before);
    });
  }
}

test("rollback restores updated DNS fields and the existing custom origin", async (t) => {
  let failed = false;
  const env = await environment(t, { dnsRecords: [origin, access, fallback], customHostnames: [hostname],
    intercept({ call, apply, send }) {
      if (failed || call.method !== "PATCH" || call.path !== `${base}/dns_records/${access.id}`) return false;
      failed = true;
      apply();
      send(null, 502);
      return true;
    } });
  const before = structuredClone(env.state);
  await assert.rejects(env.service.deploy(zoneId, input), (error) => error.rollback.status === "complete");
  assert.deepEqual(env.state, before);
});

test("conflicting shared fallback origin is rejected before any writes", async (t) => {
  const env = await environment(t, { fallbackOrigin: { origin: "other.alpha.example", status: "active" } });
  const before = structuredClone(env.state);
  await assert.rejects(env.service.deploy(zoneId, input), /回退源.*其他/);
  assert.deepEqual(env.state, before);
  assert.ok(env.requests.every((call) => call.method === "GET"));
});

test("preflight catches fallback DNS conflicts before changing access DNS", async (t) => {
  const env = await environment(t, { dnsRecords: [origin, access, { ...fallback, content: "192.0.2.99" }] });
  const before = structuredClone(env.state);
  await assert.rejects(env.service.deploy(zoneId, input), /已存在其它解析/);
  assert.deepEqual(env.state, before);
  assert.ok(env.requests.every((call) => call.method === "GET"));
});

test("snapshot read failures abort without mutation", async (t) => {
  const env = await environment(t, { intercept({ call, send }) {
    if (call.method !== "GET" || !call.path.endsWith("/fallback_origin")) return false;
    send(null, 403);
    return true;
  } });
  await assert.rejects(env.service.deploy(zoneId, input));
  assert.ok(env.requests.every((call) => call.method === "GET"));
});

test("rollback failures are reported and do not prevent independent cleanup", async (t) => {
  const env = await environment(t, { intercept({ call, send }) {
    if ((call.method === "POST" && call.path.endsWith("/dns_records") && call.body.name === input.accessDomain)
      || (call.method === "DELETE" && /\/custom_hostnames\/hostname-/.test(call.path))) {
      send(null, 502);
      return true;
    }
    return false;
  } });
  await assert.rejects(env.service.deploy(zoneId, input), (error) => {
    assert.equal(error.rollback.status, "incomplete");
    assert.match(error.message, /恢复未完成.*自定义主机名/);
    assert.ok(error.rollback.steps.some((step) => step.status === "failed"));
    return true;
  });
  assert.deepEqual(env.state.dnsRecords, [origin]);
  assert.equal(env.state.fallbackOrigin, null);
  assert.equal(env.state.customHostnames.length, 1);
});

test("rollback does not overwrite an independently edited DNS record", async (t) => {
  const env = await environment(t, { dnsRecords: [origin, access], intercept({ call, state, apply, send }) {
    if (call.method !== "PATCH" || call.path !== `${base}/dns_records/${access.id}`) return false;
    apply();
    state.dnsRecords.find((record) => record.id === access.id).content = "external-edit.example";
    send(null, 502);
    return true;
  } });
  await assert.rejects(env.service.deploy(zoneId, input), (error) => error.rollback.status === "incomplete");
  assert.equal(env.state.dnsRecords.find((record) => record.id === access.id).content, "external-edit.example");
});

test("unconfirmed DNS creation with externally added tags is preserved for manual review", async (t) => {
  let failed = false;
  const env = await environment(t, { intercept({ call, apply, send }) {
    if (failed || call.method !== "POST") return false;
    failed = true;
    apply().tags = ["owner:external"];
    send(null, 502);
    return true;
  } });
  await assert.rejects(env.service.deploy(zoneId, input), (error) => error.rollback.status === "incomplete");
  assert.deepEqual(env.state.dnsRecords.find((record) => record.name === fallback.name).tags, ["owner:external"]);
});

test("unconfirmed hostname creation with externally added metadata is preserved", async (t) => {
  const env = await environment(t, { intercept({ call, apply, send }) {
    if (call.method !== "POST" || !call.path.endsWith("/custom_hostnames")) return false;
    apply().custom_metadata = { owner: "external" };
    send(null, 502);
    return true;
  } });
  await assert.rejects(env.service.deploy(zoneId, input), (error) => error.rollback.status === "incomplete");
  assert.deepEqual(env.state.customHostnames[0].custom_metadata, { owner: "external" });
});

test("an accelerated-domain delete cannot interleave with a deployment", async (t) => {
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const env = await environment(t, { async intercept({ call }) {
    if (call.method !== "POST" || call.body?.name !== input.accessDomain) return false;
    entered();
    await gate;
    return false;
  } });
  const deployment = env.service.deploy(zoneId, input);
  await started;
  try {
    await assert.rejects(env.service.deleteManagedDomain(zoneId, input.accessDomain), (error) => error.statusCode === 409);
  } finally {
    release();
    await deployment;
  }
  assert.equal(env.state.customHostnames.length, 1);
  assert.ok(env.state.dnsRecords.some((record) => record.name === input.accessDomain));
});

test("an existing shared fallback origin is reused without being written or deleted", async (t) => {
  const env = await environment(t, { fallbackOrigin: { origin: fallback.name, status: "active" },
    intercept({ call, send }) {
      if (call.method !== "POST" || !call.path.endsWith("/custom_hostnames")) return false;
      send(null, 502);
      return true;
    } });
  const before = structuredClone(env.state);
  await assert.rejects(env.service.deploy(zoneId, input));
  assert.deepEqual(env.state, before);
  assert.ok(env.requests.every((call) => !call.path.endsWith("/fallback_origin") || call.method === "GET"));
});

test("a reused fallback origin changed after preflight prevents the traffic switch", async (t) => {
  const env = await environment(t, { fallbackOrigin: { origin: fallback.name, status: "active" },
    intercept({ call, state }) {
      if (call.method === "POST" && call.body?.name === fallback.name) {
        state.fallbackOrigin = { origin: "external.alpha.example", status: "active" };
      }
      return false;
    } });
  await assert.rejects(env.service.deploy(zoneId, input), /SaaS 回退源在检查后发生变化/);
  assert.deepEqual(env.state.dnsRecords, [origin]);
  assert.equal(env.state.fallbackOrigin.origin, "external.alpha.example");
  assert.equal(env.state.customHostnames.length, 0);
});

test("same-account Zone deployments cannot interleave and the lock is released", async (t) => {
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let held = false;
  const env = await environment(t, { async intercept({ call }) {
    if (held || call.method !== "GET" || !call.path.endsWith("/dns_records")) return false;
    held = true;
    entered();
    await gate;
    return false;
  } });
  const first = env.service.deploy(zoneId, input);
  await started;
  try {
    await assert.rejects(env.service.deploy(zoneId, input), (error) => error.statusCode === 409);
  } finally {
    release();
    await first;
  }
  const count = env.requests.filter((call) => call.method !== "GET").length;
  await env.service.deploy(zoneId, input);
  assert.equal(env.requests.filter((call) => call.method !== "GET").length, count, "repeated deploy is idempotent");
});
