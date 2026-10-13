import { fetchLoginSettingsSecret, fetchSessionStatus, setCsrfToken, updateLoginSettings } from "../api.js";
import { applySession } from "./session-actions.js";
import { resetSessionState, state } from "../state.js";

function readForm() {
  const form = document.querySelector("#login-settings-form");
  const data = form ? new FormData(form) : null;
  return { password: String(data?.get("password") || ""), auth: String(data?.get("auth") || "").trim(),
    totpCode: String(data?.get("totpCode") || "").trim() };
}

function restoreForm(values) {
  const form = document.querySelector("#login-settings-form");
  for (const [name, value] of Object.entries(values)) {
    const field = form?.querySelector(`[name="${name}"]`);
    if (field) field.value = value;
  }
}

export function createLoginSettingsActions({ renderApp }) {
  function openLoginSettings() {
    state.loginSettingsOpen = true;
    state.loginSettingsEnabled = state.totpEnabled;
    state.loginSettingsSecret = "";
    state.loginSettingsError = "";
    renderApp();
  }
  function closeLoginSettings() {
    if (state.loginSettingsBusy) return;
    state.loginSettingsOpen = false;
    state.loginSettingsSecret = "";
    state.loginSettingsError = "";
    renderApp();
  }
  function toggleLoginSettings(event) {
    const values = readForm();
    state.loginSettingsEnabled = Boolean(event.target.checked);
    state.loginSettingsSecret = "";
    state.loginSettingsError = "";
    renderApp();
    restoreForm(values);
  }
  async function generateLoginSettingsSecret() {
    const values = readForm();
    if (!values.password) { state.loginSettingsError = "请先输入当前密码。"; renderApp(); return; }
    state.loginSettingsBusy = true;
    state.loginSettingsError = "";
    renderApp();
    try {
      const result = await fetchLoginSettingsSecret(values);
      state.loginSettingsSecret = result.secret;
    } catch (error) { state.loginSettingsError = error.message; }
    finally { state.loginSettingsBusy = false; renderApp(); restoreForm(values); }
  }
  async function saveLoginSettings(event) {
    event.preventDefault();
    const values = readForm();
    if (state.loginSettingsEnabled && !state.loginSettingsSecret) {
      state.loginSettingsError = "请先生成密钥并添加到验证器。";
      renderApp(); restoreForm(values); return;
    }
    state.loginSettingsBusy = true;
    state.loginSettingsError = "";
    renderApp();
    try {
      const saved = await updateLoginSettings({ ...values, enabled: state.loginSettingsEnabled, totpSecret: state.loginSettingsSecret });
      state.totpEnabled = saved.totpEnabled;
      state.csrfToken = saved.csrfToken;
      state.sessionExpiresAt = saved.expiresAt;
      setCsrfToken(saved.csrfToken);
      state.loginSettingsOpen = false;
      state.loginSettingsSecret = "";
      try {
        const session = await fetchSessionStatus();
        if (!session.authenticated) {
          resetSessionState();
          state.totpEnabled = saved.totpEnabled;
          state.loginRequired = true;
          state.connected = false;
          state.sessionError = "登录方式已保存，请重新登录。";
        } else applySession(session);
      } catch {
        state.sessionError = "登录方式已保存，暂时无法确认登录状态，请刷新页面后继续。";
      }
    } catch (error) { state.loginSettingsError = error.message; }
    finally {
      state.loginSettingsBusy = false;
      renderApp();
      if (state.loginSettingsOpen) restoreForm(values);
    }
  }
  return { openLoginSettings, closeLoginSettings, toggleLoginSettings, generateLoginSettingsSecret, saveLoginSettings };
}
