import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContainer } from "../src/bootstrap.js";
import { createConfig } from "../src/config/env.js";

test("KV page API authenticates, checks account access and keeps opaque query values", async t => {
  const dir = mkdtempSync(join(tmpdir(), "kv-page-http-"));
  const container = createContainer(createConfig({ DATA_DIR: dir, SETUP_TOKEN: "fixture" }));
  container.panelAuthService.createPanelUserSetup({ username: "admin", password: "admin-test-password" });
  const account = container.sqliteStore.createCloudflareAccount({ email: "test@example.com", globalApiKey: "fixture-key", name: "KV fixture" });
  const session = container.credentialSessionService.create({ authenticated: true, activeCloudflareAccountId: account.id });
  const remoteAccount = "a".repeat(32), namespace = "b".repeat(32);
  const calls = [];
  container.cloudflareClient.get = async (path, query) => {
    assert.equal(container.cloudflareClient.getCredentials().accountId, account.id);
    calls.push({ path, query });
    return path === "accounts"
      ? { result: [{ id: remoteAccount }], result_info: { total_pages: 1 } }
      : { result: [{ name: "配置:一" }], result_info: { cursor: " next+/= " } };
  };
  const server = createServer(container.app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); container.sqliteStore.close(); rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/api/developer-resources/kv/${namespace}/keys`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(calls.length, 0);
  const headers = { cookie: `cf_panel_session=${session.id}` };
  const params = new URLSearchParams({ accountId: remoteAccount, cursor: " previous+/= ", prefix: "配置:", limit: "100" });
  const response = await fetch(`${url}?${params}`, { headers });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.page.cursor, " next+/= ");
  assert.equal(payload.page.prefix, "配置:");
  assert.equal(payload.page.keys[0].name, "配置:一");
  assert.deepEqual(calls[1].query, { cursor: " previous+/= ", prefix: "配置:", limit: 100 });
  calls.length = 0;
  assert.equal((await fetch(`${url}?limit=9`, { headers })).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await fetch(`${url}?accountId=${"c".repeat(32)}`, { headers })).status, 404);
  assert.equal(calls.length, 1);
});
