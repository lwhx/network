import { test, expect, login, dnsRecord, zoneA, zoneB } from "./fixtures.js";

test("a late DNS response cannot replace records after changing zones", async ({ page, panel }) => {
  await login(page, panel);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const pending = new Promise((resolve) => { started = resolve; });
  let routeFinished;
  const delivered = new Promise((resolve) => { routeFinished = resolve; });
  let requestFinished;
  const settled = new Promise((resolve) => { requestFinished = resolve; });
  const settleOldRequest = (request) => {
    if (request.url().endsWith(`/api/zones/${zoneA}/dns-records`)) requestFinished();
  };
  page.on("requestfinished", settleOldRequest);
  page.on("requestfailed", settleOldRequest);
  await page.route(`**/api/zones/${zoneA}/dns-records`, async (route) => {
    started();
    await gate;
    await route.fulfill({ json: { records: [dnsRecord(zoneA, "late.alpha.example")] } });
    routeFinished();
  });
  await page.locator(`[data-zone-id="${zoneA}"]`).click();
  await pending;
  await page.evaluate((id) => { location.hash = `#/zones/${id}/dns`; }, zoneB);
  await expect(page.locator(".dns-name")).toHaveText("new.beta.example");
  release();
  await Promise.all([delivered, settled]);
  // Barrier: ensure the old promise's continuation has completed before inspecting the rendered page.
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page).toHaveURL(new RegExp(`${zoneB}/dns$`));
  await expect(page.locator(".dns-name")).toHaveText("new.beta.example");
  await expect(page.getByText("late.alpha.example", { exact: true })).toHaveCount(0);
});

test("bulk create reports partial success and retries only the failed record", async ({ page, panel }) => {
  await login(page, panel);
  await page.locator(`[data-zone-id="${zoneA}"]`).click();
  await expect(page.locator(".dns-name")).toHaveText("old.alpha.example");
  panel.rejectNextCreate("retry.alpha.example");
  await page.locator("#open-dns-bulk-form").click();
  const form = page.locator("#dns-bulk-form");
  await form.locator('[name="records"]').fill("A done.alpha.example 192.0.2.20\nA retry.alpha.example 192.0.2.21");
  const bulk = page.waitForResponse(`**/api/zones/${zoneA}/dns-records/bulk`);
  await form.locator('[type="submit"]').click();
  expect((await bulk).status()).toBe(207);
  const results = page.getByRole("region", { name: "批量操作结果" });
  await expect(results.getByRole("row").filter({ hasText: "done.alpha.example" })).toContainText("成功");
  await expect(results.getByRole("row").filter({ hasText: "retry.alpha.example" })).toContainText("失败");
  await expect(page.locator(".dns-name")).toHaveText(["old.alpha.example", "done.alpha.example"]);
  await results.locator("#dns-bulk-retry").click();
  await expect(results.getByRole("row").filter({ hasText: "retry.alpha.example" })).toContainText("成功");
  await expect(results.locator("#dns-bulk-retry")).toBeDisabled();
  await expect(page.locator(".dns-name")).toHaveText(["old.alpha.example", "done.alpha.example", "retry.alpha.example"]);
  const writes = panel.calls.filter((call) => call.method === "POST" && call.path.endsWith("/dns_records"));
  expect(writes.map((call) => call.body.name)).toEqual(["done.alpha.example", "retry.alpha.example", "retry.alpha.example"]);
});
