import { test, expect, login, password, setupToken, totp, username, zoneA } from "./fixtures.js";

test.describe("first initialization", () => {
  test.use({ seeded: false });
  test("defaults to password-only setup and enters the panel", async ({ page, panel }) => {
    await page.goto(panel.origin);
    const admin = page.locator("#panel-setup-form");
    await expect(admin.locator("#setup-use-2fa")).not.toBeChecked();
    await expect(admin.locator('[name="totpCode"]')).toHaveCount(0);
    await admin.locator('[name="setupToken"]').fill(setupToken);
    await admin.locator('[name="username"]').fill(username);
    await admin.locator('[name="password"]').fill(password);
    await admin.locator('[name="confirmPassword"]').fill(password);
    await admin.locator('[type="submit"]').click();
    const accounts = page.locator("#cloudflare-accounts-setup-form");
    await accounts.locator('[name="cfEmail"]').fill("mock@example.com");
    await accounts.locator('[name="cfApiKey"]').fill("fake-key-for-local-mock-only");
    await accounts.locator('[type="submit"]').click();
    await expect(page.locator(`[data-zone-id="${zoneA}"]`)).toBeVisible();
    await page.locator("#logout-session").click();
    await expect(page.locator('#cloudflare-connect-form [name="auth"]')).toHaveCount(0);
  });
});

test("remembered login survives the application restart and logout revokes it", async ({ page, context, panel }) => {
  await page.goto(panel.origin);
  await expect(page.locator('#cloudflare-connect-form [name="remember"]')).toBeChecked();
  await expect(page.locator('#cloudflare-connect-form [name="auth"]')).toHaveCount(0);
  await login(page, panel);
  const cookie = (await context.cookies()).find((item) => item.name === "cf_panel_session");
  expect(cookie.expires).toBeGreaterThan(Date.now() / 1000);
  await panel.restart();
  await page.reload();
  await expect(page.locator(`[data-zone-id="${zoneA}"]`)).toBeVisible();
  await page.locator("#logout-session").click();
  await expect(page.locator("#cloudflare-connect-form")).toBeVisible();
  await panel.restart();
  await page.reload();
  await expect(page.locator("#cloudflare-connect-form")).toBeVisible();
  expect((await context.cookies()).filter((item) => item.name === "cf_panel_session")).toHaveLength(0);
});

test("login settings enable and disable 2FA through the rendered forms", async ({ page, panel }) => {
  await login(page, panel);
  await page.locator("#login-settings-open").click();
  let settings = page.getByRole("dialog", { name: "登录设置" });
  await settings.locator("#login-settings-2fa").check();
  await settings.locator('[name="password"]').fill(password);
  const generated = page.waitForResponse("**/api/session/security/secret");
  await settings.locator("#login-settings-secret").click();
  const { secret } = await (await generated).json();
  await expect(settings.locator(".setup-secret-box span")).toHaveText(secret);
  await settings.locator('[name="totpCode"]').fill(totp(secret));
  await settings.locator('[type="submit"]').click();
  await expect(settings).toHaveCount(0);
  await page.locator("#logout-session").click();
  await expect(page.locator('#cloudflare-connect-form [name="auth"]')).toBeVisible();
  await login(page, panel, { auth: totp(secret) });
  await page.locator("#login-settings-open").click();
  settings = page.getByRole("dialog", { name: "登录设置" });
  await settings.locator("#login-settings-2fa").uncheck();
  await settings.locator('[name="password"]').fill(password);
  await settings.locator('[name="auth"]').fill(totp(secret));
  await settings.locator('[type="submit"]').click();
  await expect(settings).toHaveCount(0);
  await page.locator("#logout-session").click();
  await expect(page.locator('#cloudflare-connect-form [name="auth"]')).toHaveCount(0);
  await login(page, panel);
});
