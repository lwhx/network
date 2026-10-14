import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContainer } from "../src/bootstrap.js";
import { createConfig } from "../src/config/env.js";

async function listen(server) { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }

test("API history persists scope and partial outcomes across restart without raw upstream errors", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "persistent-audit-http-"));
  const zoneId = "a".repeat(32);
  const mock = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    const zones = request.url.startsWith("/zones?");
    const rejected = body.name === "denied.alpha.example";
    response.writeHead(rejected ? 403 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: !rejected, errors: rejected ? [{ message: "upstream echoed private-key and private-DNS-value" }] : [],
      result: zones ? [{ id: zoneId, name: "alpha.example" }] : { ...body, id: "b".repeat(32) }, result_info: { total_pages: 1 } }));
  });
  const api = await listen(mock);
  const config = createConfig({ DATA_DIR: dir, SETUP_TOKEN: "token", CLOUDFLARE_API_BASE_URL: api });
  let container = createContainer(config); let server = createServer(container.app); let origin = await listen(server);
  t.after(async () => { await close(server); await close(mock); container.sqliteStore.close(); rmSync(dir, { recursive: true, force: true }); });
  container.panelAuthService.createPanelUserSetup({ username: "admin", password: "admin-test-password" });
  const account = container.sqliteStore.createCloudflareAccount({ email: "admin@example.com", globalApiKey: "private-key", name: "Audit Account" });
  const session = container.credentialSessionService.create({ authenticated: true, activeCloudflareAccountId: account.id });
  const headers = { cookie: `cf_panel_session=${session.id}`, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json", origin };
  await fetch(`${origin}/api/zones`, { headers });
  const result = await fetch(`${origin}/api/zones/${zoneId}/dns-records/bulk`, { method: "POST", headers,
    body: JSON.stringify({ records: [{ type: "A", name: "good.alpha.example", content: "192.0.2.1" }, { type: "TXT", name: "denied.alpha.example", content: "private-DNS-value" }] }) });
  assert.equal(result.status, 207);
  const before = await (await fetch(`${origin}/api/operation-history`, { headers })).json();
  assert.equal(before.history.entries[0].status, "partial");
  assert.equal(before.history.entries[0].accountId, account.id);
  assert.equal(before.history.entries[0].zoneName, "alpha.example");
  assert.ok(!JSON.stringify(before).includes("private-DNS-value"));
  await close(server); container.sqliteStore.close();
  container = createContainer(config); server = createServer(container.app); origin = await listen(server); headers.origin = origin;
  const after = await (await fetch(`${origin}/api/operation-history?accountId=${account.id}&zoneId=${zoneId}&status=partial`, { headers })).json();
  assert.equal(after.history.entries.length, 1);
  assert.equal(after.history.entries[0].summary.succeeded, 1);
  assert.equal(after.history.entries[0].summary.failed, 1);
});
