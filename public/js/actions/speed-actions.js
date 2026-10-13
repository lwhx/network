import {
  deploySpeedAcceleration,
  fetchSpeedAcceleratedDomains,
  removeSpeedAcceleratedDomain,
} from "../api.js";
import { defaultSpeedForm } from "../constants.js";
import { state } from "../state.js";
import { beginScopedRequest, captureRequestContext } from "../request-scope.js";

const progressStages = [
  { delay: 160, value: 18 },
  { delay: 420, value: 36 },
  { delay: 720, value: 58 },
  { delay: 980, value: 78 },
];

function readSpeedForm() {
  const form = document.querySelector("#speed-form");

  if (!form) {
    return { ...defaultSpeedForm };
  }

  const formData = new FormData(form);
  const optimizedDomain = String(
    formData.get("optimizedDomainCustom") ||
      formData.get("optimizedDomain") ||
      defaultSpeedForm.optimizedDomain
  )
    .trim()
    .toLowerCase();

  return {
    accessDomain: String(formData.get("accessDomain") || "").trim().toLowerCase(),
    targetDomain: String(formData.get("targetDomain") || "").trim().toLowerCase(),
    cacheTtl: String(formData.get("cacheTtl") || defaultSpeedForm.cacheTtl).trim(),
    optimizedDomain,
    optimizedDomainCustom: String(formData.get("optimizedDomainCustom") || "")
      .trim()
      .toLowerCase(),
  };
}

function cacheTtlLabel(cacheTtl) {
  return cacheTtl === "0" ? "不开启缓存" : `${cacheTtl} 秒`;
}

function workerNameFromDomain(domain) {
  return domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "speed-worker";
}

function validateSpeedForm(form) {
  if (!form.targetDomain) {
    return "请输入源站域名";
  }

  if (!form.accessDomain) {
    return "请输入访问域名";
  }

  if (!/^\d+$/.test(form.cacheTtl) || Number(form.cacheTtl) < 0) {
    return "缓存时间必须是非负整数";
  }

  if (!form.optimizedDomain) {
    return "请选择或输入优选域名";
  }

  return "";
}

function findZoneForAccessDomain(accessDomain) {
  const normalizedDomain = String(accessDomain || "").toLowerCase();

  return state.zones
    .filter(
      (zone) =>
        normalizedDomain === zone.name ||
        normalizedDomain.endsWith(`.${String(zone.name || "").toLowerCase()}`)
    )
    .sort((left, right) => right.name.length - left.name.length)[0];
}

function makeAcceleratedDomain(form, deployment) {
  return {
    id: `${form.accessDomain}-${Date.now()}`,
    accessDomain: form.accessDomain,
    accessRecord: deployment?.accessRecord || null,
    fallbackOrigin: deployment?.fallbackOrigin?.origin || "",
    targetDomain: form.targetDomain,
    optimizedDomain: form.optimizedDomain,
    cacheTtl: form.cacheTtl,
    cacheTtlLabel: cacheTtlLabel(form.cacheTtl),
    workerName: workerNameFromDomain(form.accessDomain),
    status: deployment?.customHostname?.status || "运行中",
    createdAt: new Date().toISOString(),
  };
}

function speedDomainIdentity(domain) {
  return String(domain?.id || domain?.accessDomain || domain?.domain || "");
}

function zoneForSpeedDomain(domain) {
  return findZoneForAccessDomain(domain.accessDomain || domain.domain || "");
}

function readSpeedContext() {
  return JSON.stringify([state.view, state.mainSection, state.speedStep]);
}

function readSpeedDomainsContext() {
  return JSON.stringify([readSpeedContext(), state.speedDomainsOpen, state.zones.map((zone) => zone.id)]);
}

export function createSpeedActions({ renderApp }) {
  let activeDeployRun = 0;
  let deployTimers = [];

  function clearDeployTimers() {
    deployTimers.forEach((timerId) => window.clearTimeout(timerId));
    deployTimers = [];
  }

  function cancelDeploy() {
    activeDeployRun += 1;
    clearDeployTimers();
    state.speedDeploying = false;
    state.speedProgress = 0;
  }

  function showSpeedNotice(message) {
    const noticeScope = captureRequestContext(() => JSON.stringify([state.view, state.mainSection]));
    state.speedNotice = message;
    renderApp();

    window.setTimeout(() => {
      if (noticeScope.isCurrent() && state.speedNotice === message) {
        state.speedNotice = "";
        renderApp();
      }
    }, 1800);
  }

  function submitSpeedConfig(event) {
    event.preventDefault();
    const form = readSpeedForm();
    const error = validateSpeedForm(form);

    if (error) {
      showSpeedNotice(error);
      return;
    }

    state.speedForm = form;
    state.speedProgress = 0;
    state.speedNotice = "";
    state.speedStep = "deploy";
    renderApp();
  }

  function backToSpeedConfig() {
    cancelDeploy();
    state.speedStep = "domains";
    renderApp();
  }

  async function startSpeedDeploy() {
    const error = validateSpeedForm(state.speedForm);

    if (error) {
      showSpeedNotice(error);
      state.speedStep = "domains";
      renderApp();
      return;
    }

    const zone = findZoneForAccessDomain(state.speedForm.accessDomain);

    if (!zone) {
      showSpeedNotice("访问域名不在当前 Cloudflare 账号域名列表中");
      return;
    }

    cancelDeploy();
    activeDeployRun += 1;
    const deployRun = activeDeployRun;
    const form = { ...state.speedForm };
    const requestScope = captureRequestContext(() => JSON.stringify([readSpeedContext(), state.speedForm]));
    state.speedDeploying = true;
    state.speedProgress = 0;
    state.speedNotice = "";
    renderApp();

    progressStages.forEach((stage) => {
      const timerId = window.setTimeout(() => {
        if (!requestScope.isCurrent() || deployRun !== activeDeployRun || !state.speedDeploying) {
          return;
        }

        state.speedProgress = stage.value;
        renderApp();
      }, stage.delay);
      deployTimers.push(timerId);
    });

    try {
      const deployment = await deploySpeedAcceleration(zone.id, {
        ...form,
        zoneName: zone.name,
      });

      if (!requestScope.isCurrent() || deployRun !== activeDeployRun || !state.speedDeploying) {
        return;
      }

      const nextDomain = makeAcceleratedDomain(form, deployment);
      const existingIndex = state.speedAcceleratedDomains.findIndex(
        (domain) => domain.accessDomain === nextDomain.accessDomain
      );

      if (existingIndex >= 0) {
        state.speedAcceleratedDomains[existingIndex] = nextDomain;
      } else {
        state.speedAcceleratedDomains = [nextDomain, ...state.speedAcceleratedDomains];
      }

      state.speedDeploying = false;
      state.speedProgress = 100;
      state.speedStep = "complete";
      renderApp();
    } catch (deployError) {
      if (!requestScope.isCurrent() || deployRun !== activeDeployRun) {
        return;
      }

      clearDeployTimers();
      state.speedDeploying = false;
      state.speedProgress = 0;
      showSpeedNotice(deployError.message || "部署一键加速失败");
    } finally {
      if (deployRun === activeDeployRun) {
        clearDeployTimers();
      }
    }
  }

  function deployNextSpeedDomain() {
    cancelDeploy();
    state.speedStep = "domains";
    state.speedForm = { ...defaultSpeedForm };
    state.speedNotice = "";
    renderApp();
  }

  function openSpeedDomainsDialog() {
    state.speedDomainsOpen = true;
    renderApp();
    refreshSpeedDomainsDialog();
  }

  function closeSpeedDomainsDialog() {
    state.speedDomainsOpen = false;
    state.speedDomainDeleteId = "";
    renderApp();
  }

  async function refreshSpeedDomainsDialog() {
    state.speedDomainsLoading = true;
    state.speedNotice = "";
    renderApp();

    const requestScope = beginScopedRequest("speed:refreshSpeedDomainsDialog", readSpeedDomainsContext);

    try {
      const results = await Promise.all(
        state.zones.map((zone) =>
          fetchSpeedAcceleratedDomains(zone.id)
            .then((payload) =>
              (payload.domains || []).map((domain) => ({
                ...domain,
                zoneId: zone.id,
                zoneName: zone.name,
              }))
            )
            .catch(() => [])
        )
      );
      if (!requestScope.isCurrent()) {
        return;
      }
      state.speedAcceleratedDomains = results.flat();
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      showSpeedNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.speedDomainsLoading = false;
        renderApp();
      }
    }
  }

  function requestDeleteSpeedDomain(domainId) {
    state.speedDomainDeleteId = domainId;
    renderApp();
  }

  function cancelDeleteSpeedDomain() {
    state.speedDomainDeleteId = "";
    renderApp();
  }

  async function confirmDeleteSpeedDomain() {
    const deleteId = String(state.speedDomainDeleteId || "");

    if (!deleteId) {
      return;
    }

    const domain = state.speedAcceleratedDomains.find(
      (item) => speedDomainIdentity(item) === deleteId
    );
    const zone = domain?.zoneId ? { id: domain.zoneId } : zoneForSpeedDomain(domain || {});

    if (!domain || !zone?.id) {
      showSpeedNotice("未找到加速域名所属 Zone");
      return;
    }

    state.speedDomainsLoading = true;
    renderApp();

    let requestScope = captureRequestContext(() => JSON.stringify([readSpeedDomainsContext(), state.speedDomainDeleteId]));

    try {
      await removeSpeedAcceleratedDomain(zone.id, domain.accessDomain || domain.domain);
      if (!requestScope.isCurrent()) {
        return;
      }
      state.speedDomainDeleteId = "";
      requestScope = captureRequestContext(() => JSON.stringify([readSpeedDomainsContext(), state.speedDomainDeleteId]));
      await refreshSpeedDomainsDialog();
      if (!requestScope.isCurrent()) {
        return;
      }
      showSpeedNotice("加速域名已删除");
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      showSpeedNotice(error.message);
      state.speedDomainsLoading = false;
      renderApp();
    }
  }

  return {
    backToSpeedConfig,
    cancelDeleteSpeedDomain,
    closeSpeedDomainsDialog,
    confirmDeleteSpeedDomain,
    deployNextSpeedDomain,
    openSpeedDomainsDialog,
    refreshSpeedDomainsDialog,
    requestDeleteSpeedDomain,
    startSpeedDeploy,
    submitSpeedConfig,
  };
}
