import { test, expect, login, zoneA } from "./fixtures.js";

test("partial operation history survives restart and can filter account, domain and time", async ({ page, panel }) => {
  await login(page, panel);
  await page.locator(`[data-zone-id="${zoneA}"]`).click();
  await page.locator("#open-dns-bulk-form").click();
  panel.rejectNextCreate("denied.alpha.example");
  await page.locator('[name="records"]').fill("A good.alpha.example 192.0.2.1\nA denied.alpha.example 192.0.2.2");
  await page.locator('#dns-bulk-form [type="submit"]').click();
  await expect(page.getByLabel("批量操作结果")).toContainText("失败");
  await page.locator('[data-main-section="history"]').click();
  await expect(page.locator(".history-row .history-status.partial")).toHaveCount(1);
  await expect(page.locator(".history-row").last()).toContainText("alpha.example");
  await panel.restart();
  await page.reload();
  await page.locator('[data-main-section="history"]').click();
  await expect(page.locator(".history-row .history-status.partial")).toHaveCount(1);
  const account = page.locator('[data-history-filter="accountId"]');
  const accountId = await account.locator("option").nth(1).getAttribute("value");
  await account.selectOption(accountId);
  await page.locator('[data-history-filter="zoneId"]').selectOption(zoneA);
  await page.locator('[data-history-filter="status"]').selectOption("partial");
  await expect(page.locator(".history-row .history-status.partial")).toHaveCount(1);
  const from = page.locator('[data-history-filter="from"]');
  await from.fill("2099-01-01T00:00"); await from.dispatchEvent("change");
  await expect(page.getByText("暂无操作记录", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a persisted confirmed task restores original DNS after application restart", async ({ page, panel }) => {
  const id = panel.seedRecoveryTask();
  const writesBefore = panel.calls.filter((call) => call.method !== "GET").length;
  await panel.restart();
  expect(panel.calls.filter((call) => call.method !== "GET").length).toBe(writesBefore);
  await login(page, panel);
  await page.locator('[data-main-section="speed"]').click();
  await page.locator(`.speed-task-inspect[data-task-id="${id}"]`).click();
  await expect(page.getByLabel("加速任务详情")).toContainText("与本任务修改一致");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#speed-task-recover").click();
  await expect(page.getByLabel("加速任务详情")).toContainText("已恢复原配置");
  expect(panel.recordContent()).toBe("192.0.2.10");
  await panel.restart(); await page.reload();
  await page.locator('[data-main-section="speed"]').click();
  await expect(page.getByLabel("加速任务记录")).toContainText("已恢复");
});

test("recovery preserves external changes and manual acknowledgement releases the task", async ({ page, panel }) => {
  const id = panel.seedRecoveryTask({ externalChange: true });
  await login(page, panel);
  await page.locator('[data-main-section="speed"]').click();
  await page.locator(`.speed-task-inspect[data-task-id="${id}"]`).click();
  await expect(page.getByLabel("加速任务详情")).toContainText("配置已被其他操作修改");
  const writes = panel.calls.filter((call) => call.method !== "GET").length;
  page.once("dialog", (dialog) => dialog.accept()); await page.locator("#speed-task-recover").click();
  await expect(page.getByLabel("加速任务详情")).toContainText("配置已被其他操作修改");
  expect(panel.recordContent()).toBe("192.0.2.99");
  expect(panel.calls.filter((call) => call.method !== "GET").length).toBe(writes);
  page.once("dialog", (dialog) => dialog.accept()); await page.locator("#speed-task-resolve").click();
  await expect(page.getByLabel("加速任务详情")).toContainText("已确认人工处理");
});

test("unconfirmed writes remain manual and the recovery page fits a mobile viewport", async ({ page, panel }) => {
  const id = panel.seedRecoveryTask({ pending: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, panel);
  await page.locator('[data-main-section="speed"]').click();
  await page.locator(`.speed-task-inspect[data-task-id="${id}"]`).click();
  await expect(page.getByLabel("加速任务详情")).toContainText("写入结果未确认");
  page.once("dialog", (dialog) => dialog.accept()); await page.locator("#speed-task-recover").click();
  await expect(page.getByLabel("加速任务详情")).toContainText("待人工核查");
  expect(panel.recordContent()).toBe("192.0.2.20");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
