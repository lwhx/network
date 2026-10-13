import {
  applyAutomationPreset,
  fetchAutomationState,
  saveAutomationDnsProxy,
  saveAutomationFirewallRule,
  saveAutomationPageRule,
  saveAutomationSettings,
  saveAutomationTieredCaching,
} from "../api.js";
import { state } from "../state.js";
import { beginScopedRequest, captureRequestContext } from "../request-scope.js";

function firstZoneId() {
  return state.zones[0]?.id || "";
}

function activeAutomationZoneId() {
  return state.automationZoneId || firstZoneId();
}

function readSettingValue(key) {
  return state.automationState?.settings?.[key]?.value;
}

function booleanFromDataset(value) {
  return value === "true";
}

function applyAutomationPayload(payload) {
  state.automationState = payload || null;
}

function setPending(key) {
  state.automationPendingKey = key;
  state.automationNotice = "";
}

function clearPending() {
  state.automationPendingKey = "";
}

function readAutomationContext() {
  return JSON.stringify([state.view, state.mainSection, activeAutomationZoneId()]);
}

export function createAutomationActions({ renderApp }) {
  async function ensureAutomationLoaded() {
    if (state.mainSection !== "automation" || state.view !== "domains") {
      return;
    }

    const zoneId = activeAutomationZoneId();

    if (!zoneId) {
      state.automationState = null;
      state.automationNotice = state.loadingZones ? "" : "当前账号暂无可优化的域名";
      renderApp();
      return;
    }

    if (state.automationZoneId !== zoneId || !state.automationState) {
      state.automationZoneId = zoneId;
      await loadAutomationState();
    }
  }

  async function loadAutomationState() {
    const zoneId = activeAutomationZoneId();

    if (!zoneId) {
      return;
    }

    state.automationZoneId = zoneId;
    state.automationLoading = true;
    state.automationNotice = "";
    renderApp();

    const requestScope = beginScopedRequest("automation:loadAutomationState", readAutomationContext);

    try {
      const payload = await fetchAutomationState(zoneId);
      if (!requestScope.isCurrent()) {
        return;
      }
      applyAutomationPayload(payload);
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      state.automationNotice = error.message;
    } finally {
      if (requestScope.isCurrent()) {
        state.automationLoading = false;
        renderApp();
      }
    }
  }

  async function changeAutomationZone(event) {
    const zoneId = String(event.target.value || "");

    if (!zoneId || zoneId === state.automationZoneId) {
      return;
    }

    state.automationZoneId = zoneId;
    state.automationState = null;
    await loadAutomationState();
  }

  function changeAutomationPreset(event) {
    state.automationPreset = String(event.target.value || "");
    renderApp();
  }

  async function applyAutomationPresetAction() {
    const zoneId = activeAutomationZoneId();

    if (!zoneId || state.automationApplying) {
      return;
    }

    if (!state.automationPreset) {
      state.automationNotice = "请选择优化方向";
      renderApp();
      return;
    }

    state.automationApplying = true;
    state.automationNotice = "";
    renderApp();

    const requestScope = captureRequestContext(readAutomationContext);

    try {
      const payload = await applyAutomationPreset(zoneId, state.automationPreset);
      if (!requestScope.isCurrent()) {
        return;
      }
      applyAutomationPayload(payload);
      state.automationNotice =
        state.automationPreset === "security"
          ? "安全优化配置已应用"
          : "速度优化配置已应用";
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      state.automationNotice = error.message;
    } finally {
      if (requestScope.isCurrent()) {
        state.automationApplying = false;
        renderApp();
      }
    }
  }

  async function saveSetting(updateKey, request) {
    const zoneId = activeAutomationZoneId();

    if (!zoneId || state.automationPendingKey || state.automationApplying) {
      return;
    }

    setPending(updateKey);
    renderApp();

    const requestScope = captureRequestContext(readAutomationContext);

    try {
      const payload = await request(zoneId);
      if (!requestScope.isCurrent()) {
        return;
      }
      applyAutomationPayload(payload);
      state.automationNotice = "设置已保存";
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      state.automationNotice = error.message;
    } finally {
      if (requestScope.isCurrent()) {
        clearPending();
        renderApp();
      }
    }
  }

  async function updateAutomationSetting(event) {
    const input = event.currentTarget;
    const key = input.dataset.automationSetting;

    if (!key) {
      return;
    }

    const value = input.type === "checkbox" ? input.checked : input.value;
    await saveSetting(key, (zoneId) => saveAutomationSettings(zoneId, { [key]: value }));
  }

  async function toggleAutomationMinify(event) {
    const input = event.currentTarget;
    const part = input.dataset.automationMinify;
    const current = readSettingValue("minify") || { html: true, css: true, js: true };

    if (!part || !(part in current)) {
      return;
    }

    const next = {
      html: Boolean(current.html),
      css: Boolean(current.css),
      js: Boolean(current.js),
      [part]: !Boolean(current[part]),
    };

    await saveSetting("minify", (zoneId) => saveAutomationSettings(zoneId, { minify: next }));
  }

  async function toggleAutomationDnsProxy(event) {
    const enabled = event.currentTarget.checked;
    await saveSetting("proxy_dns_records", (zoneId) =>
      saveAutomationDnsProxy(zoneId, enabled)
    );
  }

  async function toggleAutomationFirewall(event) {
    const input = event.currentTarget;
    const key = input.dataset.automationFirewall;

    if (!key) {
      return;
    }

    await saveSetting(key, (zoneId) =>
      saveAutomationFirewallRule(zoneId, key, input.checked)
    );
  }

  async function toggleAutomationPageRule(event) {
    const input = event.currentTarget;
    const key = input.dataset.automationPageRule;

    if (!key) {
      return;
    }

    await saveSetting(key, (zoneId) => saveAutomationPageRule(zoneId, key, input.checked));
  }

  async function toggleAutomationTieredCaching(event) {
    const input = event.currentTarget;
    await saveSetting("tiered_caching", (zoneId) =>
      saveAutomationTieredCaching(zoneId, input.checked)
    );
  }

  async function toggleUnderAttackMode(event) {
    const checked = event.currentTarget.checked;
    const lastSecurityLevel =
      state.automationState?.lastSecurityLevel ||
      (readSettingValue("securityLevel") === "under_attack"
        ? "high"
        : readSettingValue("securityLevel")) ||
      "high";
    const nextValue = checked ? "under_attack" : lastSecurityLevel;

    await saveSetting("securityLevel", async (zoneId) => {
      const payload = await saveAutomationSettings(zoneId, { securityLevel: nextValue });

      if (nextValue !== "under_attack") {
        payload.lastSecurityLevel = nextValue;
      }

      return payload;
    });
  }

  function rememberCurrentSecurityLevel() {
    const value = readSettingValue("securityLevel");

    if (value && value !== "under_attack") {
      state.automationState = {
        ...state.automationState,
        lastSecurityLevel: value,
      };
    }
  }

  async function updateAutomationSecurityLevel(event) {
    rememberCurrentSecurityLevel();
    await updateAutomationSetting(event);
  }

  function resetAutomationNotice() {
    state.automationNotice = "";
    renderApp();
  }

  return {
    applyAutomationPreset: applyAutomationPresetAction,
    changeAutomationPreset,
    changeAutomationZone,
    ensureAutomationLoaded,
    loadAutomationState,
    resetAutomationNotice,
    toggleAutomationDnsProxy,
    toggleAutomationFirewall,
    toggleAutomationMinify,
    toggleAutomationPageRule,
    toggleAutomationTieredCaching,
    toggleUnderAttackMode,
    updateAutomationSecurityLevel,
    updateAutomationSetting,
  };
}
