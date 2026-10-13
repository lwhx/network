import { state } from "../state.js";
import { escapeHtml } from "../utils.js";

export function renderLoginSettingsDialog() {
  if (!state.loginSettingsOpen) return "";
  const enabling = state.loginSettingsEnabled && !state.totpEnabled;
  const busy = state.loginSettingsBusy;
  return `<div class="account-dialog-backdrop">
    <section class="account-dialog" role="dialog" aria-modal="true" aria-label="登录设置">
      <div class="account-dialog-head"><div><h2>登录设置</h2><p>当前登录方式：${state.totpEnabled ? "账号密码 + 验证器" : "账号密码"}</p></div>
        <button type="button" class="ghost-button login-settings-close" aria-label="关闭登录设置" ${busy ? "disabled" : ""}>关闭</button></div>
      <form class="account-dialog-form" id="login-settings-form">
        <label class="login-check"><input id="login-settings-2fa" type="checkbox" ${state.loginSettingsEnabled ? "checked" : ""} ${busy ? "disabled" : ""} />启用验证器（2FA）</label>
        <label class="account-dialog-field"><span>当前密码</span><input name="password" type="password" autocomplete="current-password" placeholder="修改登录方式时确认" required /></label>
        ${state.totpEnabled ? `<label class="account-dialog-field"><span>当前验证器验证码</span><input name="auth" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required /></label>` : ""}
        ${enabling ? `<div class="setup-secret-box"><span>${escapeHtml(state.loginSettingsSecret || "生成密钥后添加到验证器")}</span>
          <button class="ghost-button" type="button" id="login-settings-secret" ${busy ? "disabled" : ""}>${state.loginSettingsSecret ? "重新生成" : "生成密钥"}</button></div>
          <label class="account-dialog-field"><span>新验证器验证码</span><input name="totpCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required /></label>` : ""}
        <p class="connect-help">保存后，其他已登录设备需要重新登录。本设备会继续保持登录。</p>
        ${state.loginSettingsError ? `<div class="notice error-notice">${escapeHtml(state.loginSettingsError)}</div>` : ""}
        <div class="account-dialog-actions"><button class="ghost-button login-settings-close" type="button" ${busy ? "disabled" : ""}>取消</button>
          <button class="primary-button" type="submit" ${busy || state.loginSettingsEnabled === state.totpEnabled ? "disabled" : ""}>${busy ? "处理中..." : "保存登录方式"}</button></div>
      </form>
    </section></div>`;
}
