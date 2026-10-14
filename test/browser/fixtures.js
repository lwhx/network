import { test as base, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContainer } from "../../src/bootstrap.js";
import { createConfig } from "../../src/config/env.js";

export const username = "browser-admin";
export const password = "Browser-password-123!";
export const setupToken = "browser-only-setup-token";
export const zoneA = "a".repeat(32);
export const zoneB = "b".repeat(32);
export const zones = [
  { id: zoneA, name: "alpha.example", status: "active", plan: { name: "Free" } },
  { id: zoneB, name: "beta.example", status: "active", plan: { name: "Free" } },
];

export function dnsRecord(zoneId, name) {
  return { id: zoneId === zoneA ? "c".repeat(32) : "d".repeat(32), name,
    type: "A", content: "192.0.2.10", ttl: 1, proxied: false, proxiable: true };
}

export function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of secret.replace(/\s+/g, "")) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hash = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function listen(server, port = 0) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function createPanel({ seed, cloudflareTimeoutMs }) {
  const dataDir = await mkdtemp(join(tmpdir(), "network-browser-"));
  const calls = [];
  const records = new Map([
    [zoneA, [dnsRecord(zoneA, "old.alpha.example")]],
    [zoneB, [dnsRecord(zoneB, "new.beta.example")]],
  ]);
  const rejectedCreates = new Set();
  const stalledResponses = [];
  let nextRecord = 100;
  // This mock is the only Cloudflare endpoint used by the app; no external credentials or API calls.
  const mock = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ method: request.method, path: url.pathname, body,
      email: request.headers["x-auth-email"], apiKey: request.headers["x-auth-key"] });
    let result;
    if (url.pathname === "/zones") result = zones;
    else if (url.pathname.match(/^\/zones\/[a-f0-9]{32}\/dns_records\/[a-f0-9]{32}$/)) {
      const [, , zoneId, , recordId] = url.pathname.split("/");
      const items = records.get(zoneId);
      const index = items.findIndex((item) => item.id === recordId);
      if (index < 0) {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: false, errors: [{ message: "Record not found" }] })); return;
      }
      if (request.method === "PATCH") { items[index] = { ...items[index], ...body }; result = items[index]; }
      else if (request.method === "DELETE") { items.splice(index, 1); result = { id: recordId }; }
      else result = items[index];
    }
    else if (url.pathname.match(/^\/zones\/[a-f0-9]{32}\/dns_records$/)) {
      const id = url.pathname.split("/")[2];
      if (request.method === "POST") {
        if (rejectedCreates.delete(body.name)) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ success: false, errors: [{ message: "Injected record rejection" }] }));
          return;
        }
        result = { ...body, id: String(nextRecord++).padStart(32, "0") };
        records.get(id).push(result);
      } else result = records.get(id);
    } else if (url.pathname === "/user") result = { id: "mock-user" };
    else if (url.pathname === "/accounts") result = [{ id: "e".repeat(32), name: "Mock account" }];
    else {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, errors: [{ message: `Unexpected mock endpoint: ${url.pathname}` }] }));
      return;
    }
    const stallIndex = stalledResponses.findIndex(item => item.method === request.method && item.path === url.pathname);
    if (stallIndex >= 0) {
      stalledResponses.splice(stallIndex, 1);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"success":true,"result":');
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: true, result, result_info: { page: 1, total_pages: 1 }, errors: [] }));
  });
  const mockOrigin = await listen(mock);
  const config = createConfig({ DATA_DIR: dataDir, SETUP_TOKEN: setupToken, CLOUDFLARE_API_BASE_URL: mockOrigin,
    CLOUDFLARE_REQUEST_TIMEOUT_MS: String(cloudflareTimeoutMs) });
  let container;
  let server;
  let port = 0;
  const panel = { origin: "", calls,
    seedRecoveryTask({ externalChange = false, pending = false } = {}) {
      const accountId = container.cloudflareAccountService.getDefaultAccount().id;
      const original = records.get(zoneA)[0];
      const fields = (record) => ({ id: record.id, type: record.type, name: record.name, content: record.content,
        ttl: record.ttl, proxied: record.proxied, comment: record.comment || "", tags: record.tags || [] });
      const before = fields(original);
      const expected = { ...before, content: "192.0.2.20" };
      records.get(zoneA)[0] = { ...original, content: externalChange ? "192.0.2.99" : expected.content };
      container.speedTaskStore.acquireScope(accountId, zoneA);
      const id = container.speedTaskStore.begin(accountId, { zoneId: zoneA, zoneName: "alpha.example", accessDomain: original.name });
      const { id: ignored, ...creationBody } = expected;
      container.speedTaskStore.save(id, accountId, { steps: [{ type: "dns", zoneId: zoneA, label: "访问域名 DNS", before, expected,
        creationBody, confirmed: !pending, status: pending ? "pending" : "confirmed" }], audit: [] }, { status: "manual_needed" });
      return id;
    },
    recordContent() { return records.get(zoneA)[0].content; },
    rejectNextCreate(name) { rejectedCreates.add(name); },
    stallNextResponse(method, path) { stalledResponses.push({ method, path }); },
    async restart() {
      if (server) { await close(server); container.sqliteStore.close(); }
      container = createContainer(config);
      server = createServer(container.app);
      panel.origin = await listen(server, port);
      port = server.address().port;
    },
    async dispose() {
      await close(server);
      container.sqliteStore.close();
      await close(mock);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  await panel.restart();
  if (seed) {
    const admin = container.panelAuthService.createPanelUserSetup({ username, password });
    const accounts = container.panelAuthService.createCloudflareAccountsSetup({ accounts: [{
      cloudflareName: "Browser fixture", cfEmail: "mock@example.com", cfApiKey: "fake-key-for-local-mock-only",
    }] });
    if (admin.statusCode !== 201 || accounts.statusCode !== 201) throw new Error("Browser fixture initialization failed");
  }
  return panel;
}

export const test = base.extend({
  seeded: [true, { option: true }],
  cloudflareTimeoutMs: [15_000, { option: true }],
  panel: async ({ seeded, cloudflareTimeoutMs }, use) => {
    const panel = await createPanel({ seed: seeded, cloudflareTimeoutMs });
    try { await use(panel); } finally { await panel.dispose(); }
  },
});
export { expect };

export async function login(page, panel, { auth } = {}) {
  await page.goto(panel.origin);
  const form = page.locator("#cloudflare-connect-form");
  await form.locator('[name="user"]').fill(username);
  await form.locator('[name="password"]').fill(password);
  if (auth) await form.locator('[name="auth"]').fill(auth);
  await form.locator('[type="submit"]').click();
  await expect(page.locator(`[data-zone-id="${zoneA}"]`)).toBeVisible();
}
