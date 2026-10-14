import { test, expect, login, zoneA } from "./fixtures.js";

test.use({ cloudflareTimeoutMs: 300 });

test("a stalled DNS response ends loading and a manual refresh works", async ({ page, panel }) => {
  await login(page, panel);
  panel.stallNextResponse("GET", `/zones/${zoneA}/dns_records`);
  const failed = page.waitForResponse(`**/api/zones/${zoneA}/dns-records`);
  await page.locator(`[data-zone-id="${zoneA}"]`).click();
  expect((await failed).status()).toBe(504);
  await expect(page.getByText("Cloudflare API 请求超时，请稍后重试。", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const refresh = page.locator("#refresh-dns");
  await expect(refresh).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(page.locator(".dns-name")).toHaveText("old.alpha.example");
  await expect(page.getByText("Cloudflare API 请求超时，请稍后重试。", { exact: true })).toHaveCount(0);
});

test("a timed-out DNS write displays unknown, stops later writes and is not retried", async ({ page, panel }) => {
  await login(page, panel);
  await page.locator(`[data-zone-id="${zoneA}"]`).click();
  await expect(page.locator(".dns-name")).toHaveText("old.alpha.example");
  panel.stallNextResponse("POST", `/zones/${zoneA}/dns_records`);
  await page.locator("#open-dns-bulk-form").click();
  const form = page.locator("#dns-bulk-form");
  await form.locator('[name="records"]').fill("A uncertain.alpha.example 192.0.2.20\nA later.alpha.example 192.0.2.21");
  const bulk = page.waitForResponse(`**/api/zones/${zoneA}/dns-records/bulk`);
  await form.locator('[type="submit"]').click();
  expect((await bulk).status()).toBe(207);
  const results = page.getByRole("region", { name: "批量操作结果" });
  await expect(results.getByRole("row").filter({ hasText: "uncertain.alpha.example" })).toContainText("结果未确认");
  await expect(results.getByRole("row").filter({ hasText: "later.alpha.example" })).toContainText("未执行");
  // The mock applied the first write before its body stalled; the automatic
  // read refresh exposes it while the report continues to preserve uncertainty.
  await expect(page.locator(".dns-name")).toHaveText(["old.alpha.example", "uncertain.alpha.example"]);
  await results.locator("#dns-bulk-retry").click();
  await expect(results.getByRole("row").filter({ hasText: "later.alpha.example" })).toContainText("成功");
  await expect(results.getByRole("row").filter({ hasText: "uncertain.alpha.example" })).toContainText("结果未确认");
  await expect(results.locator("#dns-bulk-retry")).toBeDisabled();
  const writes = panel.calls.filter(call => call.method === "POST" && call.path.endsWith("/dns_records"));
  expect(writes.map(call => call.body.name)).toEqual(["uncertain.alpha.example", "later.alpha.example"]);
});
