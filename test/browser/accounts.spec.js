import { test, expect, login } from "./fixtures.js";

test("account edits preserve a blank key and connection tests do not save candidate changes", async ({ page, panel }) => {
  await login(page, panel);
  await page.locator("#cloudflare-account-manage").click();
  const manager = page.getByRole("dialog", { name: "Cloudflare 账号管理" });
  const edit = manager.locator(".cloudflare-account-edit");
  const accountId = await edit.getAttribute("data-account-id");
  await edit.click();
  const form = manager.locator("#cloudflare-account-edit-form");
  await expect(form.locator('[name="cfEmail"]')).toHaveValue("mock@example.com");
  await expect(form.locator('[name="cfApiKey"]')).toHaveValue("");
  await form.locator('[name="cloudflareName"]').fill("Edited browser account");
  await form.locator('[name="cfEmail"]').fill("updated@example.com");
  const tested = page.waitForResponse(`**/api/session/cloudflare-accounts/${accountId}/test`);
  await form.locator("#cloudflare-account-test").click();
  expect((await tested).status()).toBe(200);
  await expect(manager.getByRole("status")).toContainText("连接正常");
  await expect(form.locator('[name="cfEmail"]')).toHaveValue("updated@example.com");
  await expect(form.locator('[name="cfApiKey"]')).toHaveValue("");
  const probe = panel.calls.filter((call) => call.path === "/zones").at(-1);
  expect(probe.email).toBe("updated@example.com");
  expect(probe.apiKey).toBe("fake-key-for-local-mock-only");
  // Read the real authenticated detail API to verify the test button did not persist the candidate.
  const beforeSave = await page.request.get(`${panel.origin}/api/session/cloudflare-accounts/${accountId}`);
  expect((await beforeSave.json()).account).toMatchObject({ name: "Browser fixture", email: "mock@example.com" });
  const saved = page.waitForResponse((response) => response.url().endsWith(`/api/session/cloudflare-accounts/${accountId}`)
    && response.request().method() === "PATCH");
  await form.locator('[type="submit"]').click();
  expect((await saved).status()).toBe(200);
  await expect(manager).toContainText("Edited browser account");
  await manager.locator(".cloudflare-account-edit").click();
  await expect(form.locator('[name="cloudflareName"]')).toHaveValue("Edited browser account");
  await expect(form.locator('[name="cfEmail"]')).toHaveValue("updated@example.com");
  await expect(form.locator('[name="cfApiKey"]')).toHaveValue("");
  expect(panel.calls.filter((call) => call.path === "/zones").at(-1).apiKey).toBe("fake-key-for-local-mock-only");
});

test("deleting the last account resumes Cloudflare setup while preserving administrator login", async ({ page, panel }) => {
  await login(page, panel);
  await page.locator("#cloudflare-account-manage").click();
  const manager = page.getByRole("dialog", { name: "Cloudflare 账号管理" });
  page.once("dialog", (dialog) => dialog.accept());
  await manager.locator(".cloudflare-account-delete").click();
  await expect(page.locator("#cloudflare-accounts-setup-form")).toBeVisible();
  await expect(page.locator("#setup-session-login-form")).toHaveCount(0);
  await expect(page.locator("#panel-setup-form")).toHaveCount(0);
  const status = await page.request.get(`${panel.origin}/api/session/status`);
  expect(await status.json()).toMatchObject({ authenticated: true, hasCredentials: false,
    setupState: { panelUserRequired: false, cloudflareAccountRequired: true } });
});

test("account management and its edit form fit a 390px mobile viewport", async ({ page, panel }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, panel);
  await page.locator("#cloudflare-account-manage").click();
  const manager = page.getByRole("dialog", { name: "Cloudflare 账号管理" });
  await manager.locator(".cloudflare-account-edit").click();
  await expect(manager.locator("#cloudflare-account-edit-form")).toBeVisible();
  await expect(manager.locator("#cloudflare-account-test")).toBeVisible();
  const dimensions = await manager.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    return { left: rectangle.left, right: rectangle.right,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
  });
  expect(dimensions.left).toBeGreaterThanOrEqual(0);
  expect(dimensions.right).toBeLessThanOrEqual(390);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
});
