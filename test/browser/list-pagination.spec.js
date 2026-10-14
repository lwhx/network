import { test, expect, login, zoneA } from "./fixtures.js";

test.use({ largeLists: true });

test("complete domain and DNS inventories survive a failed later page and manual refresh", async ({ page, panel }) => {
  await login(page, panel);
  await expect(page.locator("[data-zone-id]")).toHaveCount(55);
  await page.locator(`[data-zone-id="${zoneA}"]`).click();
  await expect(page.locator(".dns-name")).toHaveCount(101);
  await expect(page.locator(".dns-name").last()).toHaveText("record-99.alpha.example");
  panel.rejectNextDnsPage2();
  await page.locator("#refresh-dns").click();
  await expect(page.getByText("DNS 记录加载失败", { exact: true })).toBeVisible();
  await expect(page.getByText("Injected DNS page failure", { exact: true })).toBeVisible();
  await expect(page.locator(".dns-name")).toHaveCount(0);
  await page.locator("#refresh-dns").click();
  await expect(page.locator(".dns-name")).toHaveCount(101);
  expect(panel.calls.some(call => call.path === "/zones" && call.query.page === "2")).toBe(true);
  expect(panel.calls.some(call => call.path === `/zones/${zoneA}/dns_records` && call.query.page === "2")).toBe(true);
});

test("accounts and namespaces beyond the first page remain selectable", async ({ page, panel }) => {
  await login(page, panel);
  await page.locator('[data-main-section="kv"]').click();
  await expect(page.locator(".devres-open-detail")).toHaveCount(55);
  await expect(page.locator("#devres-account option")).toHaveCount(51);
  const lastAccount = String(2049).padStart(32, "0");
  await page.locator("#devres-account").selectOption(lastAccount);
  await expect(page.locator("#devres-account")).toHaveValue(lastAccount);
  await expect(page.locator(".devres-open-detail")).toHaveCount(55);
  const lastNamespace = String(252).padStart(32, "0");
  await page.locator(`.devres-open-detail[data-devres-id="${lastNamespace}"]`).click();
  await expect(page.locator("#kv-key-list")).toContainText("example:key");
  expect(panel.calls.some(call => call.path === "/accounts" && call.query.page === "2")).toBe(true);
  expect(panel.calls.some(call => call.path === `/accounts/${lastAccount}/storage/kv/namespaces` && call.query.page === "2")).toBe(true);
});
