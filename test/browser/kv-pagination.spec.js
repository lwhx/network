import { test, expect, login, kvNamespaceA, kvNamespaceB } from "./fixtures.js";

async function openKv(page, panel) {
  await login(page, panel);
  await page.locator('[data-main-section="kv"]').click();
  await page.locator(`.devres-open-detail[data-devres-id="${kvNamespaceA}"]`).click();
  await expect(page.locator(".kv-key-read")).toHaveCount(50);
}

test("KV loads beyond 50 keys, searches prefixes and preserves an editor draft", async ({ page, panel }) => {
  await openKv(page, panel);
  const editor = page.locator("#kv-value-form");
  await editor.locator('[name="key"]').fill("draft:key");
  await editor.locator('[name="value"]').fill("unsaved value\n第二行");
  await page.locator("#kv-keys-more").click();
  await expect(page.locator(".kv-key-read")).toHaveCount(100);
  await expect(editor.locator('[name="key"]')).toHaveValue("draft:key");
  await expect(editor.locator('[name="value"]')).toHaveValue("unsaved value\n第二行");
  await page.locator("#kv-keys-more").click();
  await expect(page.locator(".kv-key-read")).toHaveCount(106);
  await expect(page.locator("#kv-keys-more")).toBeDisabled();
  const search = page.locator("#kv-keys-search-form");
  await search.locator('[name="prefix"]').fill("config:10");
  await search.locator('[type="submit"]').click();
  await expect(page.locator(".kv-key-read")).toHaveCount(5);
  await expect(page.locator("#kv-key-list")).toContainText("config:104");
  await expect(editor.locator('[name="value"]')).toHaveValue("unsaved value\n第二行");
  await search.locator('[name="prefix"]').fill("配置:");
  await search.locator('[type="submit"]').click();
  await expect(page.locator(".kv-key-read")).toHaveCount(1);
  await expect(page.locator("#kv-key-list")).toContainText("配置:中文");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#kv-keys-refresh")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("KV page failure keeps loaded keys and a manual retry succeeds", async ({ page, panel }) => {
  await openKv(page, panel);
  panel.rejectNextKvPage();
  await page.locator("#kv-keys-more").click();
  await expect(page.locator("#kv-keys-notice")).toContainText("Injected KV page failure");
  await expect(page.locator(".kv-key-read")).toHaveCount(50);
  await expect(page.locator("#kv-keys-more")).toBeEnabled();
  await page.locator("#kv-keys-more").click();
  await expect(page.locator(".kv-key-read")).toHaveCount(100);
});

test("KV save and delete refresh the active prefix without clearing editor content", async ({ page, panel }) => {
  await openKv(page, panel);
  const search = page.locator("#kv-keys-search-form");
  await search.locator('[name="prefix"]').fill("new:");
  await search.locator('[type="submit"]').click();
  await expect(page.locator(".kv-key-read")).toHaveCount(0);
  const editor = page.locator("#kv-value-form");
  await editor.locator('[name="key"]').fill("new:created");
  await editor.locator('[name="value"]').fill("updated value");
  await editor.locator('[type="submit"]').click();
  await expect(page.locator("#kv-key-list")).toContainText("new:created");
  await expect(search.locator('[name="prefix"]')).toHaveValue("new:");
  await expect(editor.locator('[name="value"]')).toHaveValue("updated value");
  await page.locator('.kv-key-read[data-kv-key="new:created"]').click();
  await expect(page.getByText("KV Value 已读取", { exact: true })).toBeVisible();
  await expect(editor.locator('[name="value"]')).toHaveValue("updated value");
  page.once("dialog", dialog => dialog.accept());
  await page.locator('.kv-key-delete[data-kv-key="new:created"]').click();
  await expect(page.locator(".kv-key-read")).toHaveCount(0);
  await expect(editor.locator('[name="value"]')).toHaveValue("updated value");
  await page.locator(`.devres-open-detail[data-devres-id="${kvNamespaceB}"]`).click();
  await expect(page.locator("#kv-key-list")).toContainText("other:only");
  await expect(editor.locator('[name="key"]')).toHaveValue("");
  await expect(editor.locator('[name="value"]')).toHaveValue("");
});

test("a delayed KV value read cannot overwrite a later successful save", async ({ page, panel }) => {
  await openKv(page, panel);
  const editor = page.locator("#kv-value-form");
  await editor.locator('[name="key"]').fill("config:000");
  await editor.locator('[name="value"]').fill("saved after read started");
  let started, release, finished;
  const pending = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const delivered = new Promise(resolve => { finished = resolve; });
  const routePattern = `**/api/developer-resources/kv/${kvNamespaceA}/values?*`;
  await page.route(routePattern, async route => {
    started(); await gate;
    await route.fulfill({ json: { value: { value: "old snapshot value" } } });
    finished();
  });
  await page.locator('.kv-key-read[data-kv-key="config:000"]').click(); await pending;
  await editor.locator('[type="submit"]').click();
  await expect(page.getByText("KV Value 已保存", { exact: true })).toBeVisible();
  release(); await delivered;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(editor.locator('[name="value"]')).toHaveValue("saved after read started");
  await expect(page.getByText("KV Value 已保存", { exact: true })).toBeVisible();
  await page.unroute(routePattern);
  await page.locator('.kv-key-read[data-kv-key="config:000"]').click();
  await expect(page.getByText("KV Value 已读取", { exact: true })).toBeVisible();
  await expect(editor.locator('[name="value"]')).toHaveValue("saved after read started");
});
