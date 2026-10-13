import {
  createWorker,
  createWorkerDomain,
  createWorkerPreferredRoute,
  createWorkerRoute,
  fetchWorker,
  createWorkerTail,
  fetchWorkerRoutes,
  fetchWorkers,
  removeWorkerSecret,
  removeWorker,
  removeWorkerDomain,
  removeWorkerRoute,
  saveWorkerScript,
  saveWorkerSecret,
  saveWorkerSettings,
  saveWorkerSchedules,
  saveWorkerSubdomain,
} from "../api.js";
import { state } from "../state.js";
import { beginScopedRequest, captureRequestContext } from "../request-scope.js";

const defaultWorkerScript = `addEventListener('fetch', event => {
  event.respondWith(new Response('Hello World!'));
});`;

let workerDetailRevision = 0;

function firstZoneId() {
  return state.zones[0]?.id || "";
}

function zoneName(zoneId) {
  return state.zones.find((zone) => zone.id === zoneId)?.name || "";
}

function activeAccountId() {
  return state.workersAccountId || state.workersAccounts[0]?.id || "";
}

function activeWorkerName() {
  return state.workersActiveName || state.workersActiveDetail?.worker?.name || "";
}

function readForm(formId) {
  const form = document.querySelector(formId);
  return form ? new FormData(form) : new FormData();
}

function applyWorkersPayload(payload = {}) {
  state.workersAccountId = payload.accountId || state.workersAccountId;
  state.workersAccounts = payload.accounts || state.workersAccounts;
  state.workersList = payload.workers || [];
  state.workersDomains = payload.domains || [];
  state.workersWarnings = payload.warnings || [];
  state.workersLoaded = true;
}

function setNotice(message) {
  state.workersNotice = message;
}

function selectedRouteZoneId() {
  return state.workersRouteZoneId || firstZoneId();
}

function selectedDomainZoneId() {
  return state.workersDomainZoneId || firstZoneId();
}

function selectedPreferredZoneId() {
  return state.workersPreferredZoneId || selectedRouteZoneId();
}

function normalizePreferredPattern(value) {
  let pattern = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, "")
    .split(/[?#]/)[0]
    .replace(/^\/+/, "");

  if (!pattern) {
    return "";
  }

  if (!pattern.includes("/")) {
    pattern = `${pattern}/*`;
  } else if (pattern.endsWith("/")) {
    pattern = `${pattern}*`;
  }

  return pattern;
}

function resetModalState() {
  workerDetailRevision += 1;
  state.workersModal = "";
  state.workersActiveName = "";
  state.workersActiveTab = "code";
  state.workersActiveDetail = null;
  state.workersScript = "";
  state.workersLoadingDetail = false;
  state.workersSaving = false;
  state.workersPendingKey = "";
  state.workersRoutes = [];
  state.workersRoutesLoading = false;
  state.workersDeleteName = "";
  state.workersDeleteConfirm = "";
  state.workersPreferredZoneId = "";
  state.workersPreferredPattern = "";
  state.workersPreferredHostname = "saas.sin.fan";
}

function validateWorkerName(name) {
  if (!name) {
    return "请输入 Worker 名称";
  }

  if (!/^[a-z0-9-]+$/.test(name) || name.startsWith("-") || name.endsWith("-")) {
    return "Worker 名称只能包含小写字母、数字和连字符，且不能以连字符开头或结尾";
  }

  return "";
}

function readWorkersContext() {
  return JSON.stringify([state.view, state.mainSection, activeAccountId()]);
}

function readWorkerContext() {
  return JSON.stringify([readWorkersContext(), workerDetailRevision, state.workersModal, activeWorkerName()]);
}

function readWorkerDeleteContext() {
  return JSON.stringify([readWorkerContext(), state.workersDeleteName]);
}

function readWorkerRouteContext() {
  return JSON.stringify([readWorkerContext(), selectedRouteZoneId()]);
}

function readWorkerDomainContext() {
  return JSON.stringify([readWorkerContext(), selectedDomainZoneId()]);
}

function readWorkerPreferredContext() {
  return JSON.stringify([readWorkerContext(), selectedPreferredZoneId()]);
}

export function createWorkersActions({ renderApp }) {
  async function ensureWorkersLoaded() {
    if (state.mainSection !== "workers" || state.view !== "domains") {
      return;
    }

    if (!state.workersLoaded && !state.workersLoading) {
      await loadWorkers();
    }
  }

  async function loadWorkers() {
    state.workersLoading = true;
    state.workersNotice = "";
    renderApp();

    const requestScope = beginScopedRequest("workers:loadWorkers", readWorkersContext);

    try {
      const payload = await fetchWorkers(activeAccountId());
      if (!requestScope.isCurrent()) {
        return;
      }
      // The response can select the initial account, changing the request context.
      state.workersLoading = false;
      applyWorkersPayload(payload);
      renderApp();
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
      state.workersLoading = false;
      renderApp();
    }
  }

  async function changeWorkersAccount(event) {
    state.workersAccountId = String(event.target.value || "");
    state.workersLoaded = false;
    resetModalState();
    await loadWorkers();
  }

  function openCreateWorkerModal() {
    workerDetailRevision += 1;
    state.workersModal = "create";
    state.workersActiveName = "";
    state.workersActiveDetail = null;
    state.workersScript = defaultWorkerScript;
    state.workersNotice = "";
    renderApp();
  }

  function closeWorkersModal() {
    resetModalState();
    renderApp();
  }

  async function submitCreateWorker(event) {
    event.preventDefault();
    const formData = readForm("#worker-create-form");
    const name = String(formData.get("name") || "").trim().toLowerCase();
    const script = String(formData.get("script") || "").trimEnd();
    const nameError = validateWorkerName(name);

    if (nameError) {
      setNotice(nameError);
      renderApp();
      return;
    }

    if (!script.trim()) {
      setNotice("Worker 脚本代码不能为空");
      renderApp();
      return;
    }

    state.workersSaving = true;
    renderApp();

    let requestScope = captureRequestContext(readWorkerContext);

    try {
      await createWorker({ accountId: activeAccountId(), name, script });
      if (!requestScope.isCurrent()) {
        return;
      }
      resetModalState();
      requestScope = captureRequestContext(readWorkerContext);
      await loadWorkers();
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(`Worker "${name}" 创建成功。若 Cloudflare 显示“非活动”，表示未绑定到域，但已可通过 workers.dev 访问。`);
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersSaving = false;
        renderApp();
      }
    }
  }

  async function openEditWorker(workerName, tab = "code") {
    if (!workerName) {
      return;
    }

    workerDetailRevision += 1;
    state.workersModal = "edit";
    state.workersActiveName = workerName;
    state.workersActiveTab = tab;
    state.workersActiveDetail = null;
    state.workersScript = "";
    state.workersLoadingDetail = true;
    state.workersRoutes = [];
    state.workersRouteZoneId = state.workersRouteZoneId || firstZoneId();
    state.workersDomainZoneId = state.workersDomainZoneId || firstZoneId();
    state.workersPreferredZoneId = state.workersPreferredZoneId || state.workersRouteZoneId;
    state.workersNotice = "";
    renderApp();

    const requestScope = beginScopedRequest("workers:openEditWorker", readWorkerContext);

    try {
      const payload = await fetchWorker(workerName, activeAccountId());
      if (!requestScope.isCurrent()) {
        return;
      }
      state.workersActiveDetail = payload;
      state.workersScript = state.workersActiveDetail.script || "";
      if (state.workersActiveTab === "domain") {
        await loadWorkerRoutes({ render: false });
        if (!requestScope.isCurrent()) {
          return;
        }
      }
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersLoadingDetail = false;
        renderApp();
      }
    }
  }

  async function changeWorkerTab(event) {
    const tab = String(event.currentTarget.dataset.workerTab || "code");
    state.workersActiveTab = tab;
    renderApp();

    if (tab === "domain" && activeWorkerName() && state.workersRoutes.length === 0) {
      await loadWorkerRoutes();
    }
  }

  async function submitWorkerScript(event) {
    event.preventDefault();
    const script = String(readForm("#worker-editor-form").get("script") || "").trimEnd();

    if (!script.trim()) {
      setNotice("Worker 脚本代码不能为空");
      renderApp();
      return;
    }

    state.workersSaving = true;
    renderApp();

    const requestScope = captureRequestContext(readWorkerContext);

    try {
      const payload = await saveWorkerScript(activeWorkerName(), {
        accountId: activeAccountId(),
        script,
      });
      if (!requestScope.isCurrent()) {
        return;
      }
      state.workersScript = script;
      await loadWorkers();
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(`Worker "${payload.worker?.name || activeWorkerName()}" 已保存并部署`);
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersSaving = false;
        renderApp();
      }
    }
  }

  async function toggleWorkerSubdomain(event) {
    const enabled = event.currentTarget.checked;

    state.workersPendingKey = "subdomain";
    renderApp();

    const requestScope = captureRequestContext(readWorkerContext);

    try {
      const payload = await saveWorkerSubdomain(activeWorkerName(), {
        accountId: activeAccountId(),
        enabled,
        previewsEnabled: enabled,
      });
      if (!requestScope.isCurrent()) {
        return;
      }
      state.workersActiveDetail = {
        ...state.workersActiveDetail,
        subdomain: payload.subdomain,
      };
      setNotice(enabled ? "workers.dev 子域已启用" : "workers.dev 子域已禁用");
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersPendingKey = "";
        renderApp();
      }
    }
  }

  async function loadWorkerRoutes({ render = true } = {}) {
    const zoneId = selectedRouteZoneId();

    if (!activeWorkerName() || !zoneId) {
      state.workersRoutes = [];
      return;
    }

    state.workersRoutesLoading = true;
    if (render) {
      renderApp();
    }

    const requestScope = beginScopedRequest("workers:loadWorkerRoutes", readWorkerRouteContext);

    try {
      const payload = await fetchWorkerRoutes(activeWorkerName(), zoneId);
      if (!requestScope.isCurrent()) {
        return;
      }
      state.workersRoutes = payload;
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersRoutesLoading = false;
        if (render) {
          renderApp();
        }
      }
    }
  }

  async function changeWorkerRouteZone(event) {
    state.workersRouteZoneId = String(event.target.value || "");
    await loadWorkerRoutes();
  }

  function changeWorkerDomainZone(event) {
    state.workersDomainZoneId = String(event.target.value || "");
    renderApp();
  }

  function changeWorkerPreferredZone(event) {
    const zoneId = String(event.target.value || "");
    state.workersPreferredZoneId = zoneId;
    state.workersRouteZoneId = zoneId || state.workersRouteZoneId;
    renderApp();
  }

  function changeWorkerPreferredDraft(event) {
    const field = String(event.target.name || "");

    if (field === "pattern") {
      state.workersPreferredPattern = event.target.value || "";
    } else if (field === "preferredHostname") {
      state.workersPreferredHostname = event.target.value || "";
    }
  }

  async function submitWorkerBinding(event) {
    event.preventDefault();
    const formData = readForm("#worker-binding-form");
    const type = String(formData.get("type") || "plain_text");
    const name = String(formData.get("name") || "").trim().toUpperCase();
    const value = String(formData.get("value") || "").trim();
    const currentBindings = state.workersActiveDetail?.settings?.bindings || [];
    const binding = {
      type,
      name,
      text: value,
      namespaceId: value,
      databaseId: value,
      bucketName: value,
      queueName: value,
      service: value,
    };

    state.workersPendingKey = "binding";
    renderApp();

    const requestScope = captureRequestContext(readWorkerContext);

    try {
      const payload = await saveWorkerSettings(activeWorkerName(), {
        accountId: activeAccountId(),
        bindings: [binding, ...currentBindings.filter((item) => item.name !== name)],
      });
      if (!requestScope.isCurrent()) {
        return;
      }
      state.workersActiveDetail = {
        ...state.workersActiveDetail,
        settings: payload.settings,
      };
      setNotice("Worker 绑定已保存");
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersPendingKey = "";
        renderApp();
      }
    }
  }

  async function submitWorkerSecret(event) {
    event.preventDefault();
    const formData = readForm("#worker-secret-form");
    const name = String(formData.get("name") || "").trim().toUpperCase();
    const value = String(formData.get("value") || "");

    state.workersPendingKey = "secret";
    renderApp();

    const requestScope = captureRequestContext(readWorkerContext);

    try {
      const secret = await saveWorkerSecret(activeWorkerName(), {
        accountId: activeAccountId(),
        name,
        value,
      });
      if (!requestScope.isCurrent()) {
        return;
      }
      state.workersActiveDetail = {
        ...state.workersActiveDetail,
        secrets: [secret, ...(state.workersActiveDetail?.secrets || []).filter((item) => item.name !== name)],
      };
      setNotice("Worker Secret 已保存");
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersPendingKey = "";
        renderApp();
      }
    }
  }

  async function deleteWorkerSecret(secretName) {
    if (!secretName || !window.confirm("确定删除这个 Secret 吗？")) {
      return;
    }

    state.workersPendingKey = "secret";
    renderApp();

    const requestScope = captureRequestContext(readWorkerContext);

    try {
      await removeWorkerSecret(activeWorkerName(), secretName, activeAccountId());
      if (!requestScope.isCurrent()) {
        return;
      }
      state.workersActiveDetail = {
        ...state.workersActiveDetail,
        secrets: (state.workersActiveDetail?.secrets || []).filter(
          (secret) => secret.name !== secretName
        ),
      };
      setNotice("Worker Secret 已删除");
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersPendingKey = "";
        renderApp();
      }
    }
  }

  async function submitWorkerSchedules(event) {
    event.preventDefault();
    const formData = readForm("#worker-cron-form");
    const schedules = String(formData.get("schedules") || "")
      .split(/\n+/)
      .map((cron) => cron.trim())
      .filter(Boolean);

    state.workersPendingKey = "cron";
    renderApp();

    const requestScope = captureRequestContext(readWorkerContext);

    try {
      const payload = await saveWorkerSchedules(activeWorkerName(), {
        accountId: activeAccountId(),
        schedules,
      });
      if (!requestScope.isCurrent()) {
        return;
      }
      state.workersActiveDetail = {
        ...state.workersActiveDetail,
        schedules: payload.schedules,
      };
      setNotice("Cron Triggers 已保存");
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersPendingKey = "";
        renderApp();
      }
    }
  }

  async function openWorkerTail() {
    state.workersPendingKey = "tail";
    renderApp();

    const requestScope = captureRequestContext(readWorkerContext);

    try {
      const payload = await createWorkerTail(activeWorkerName(), activeAccountId());
      if (!requestScope.isCurrent()) {
        return;
      }
      state.workersTailInfo = payload;
      setNotice("Worker Tail 会话已创建");
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersPendingKey = "";
        renderApp();
      }
    }
  }

  async function submitWorkerRoute(event) {
    event.preventDefault();
    const formData = readForm("#worker-route-form");
    const zoneId = String(formData.get("zoneId") || selectedRouteZoneId());
    const pattern = String(formData.get("pattern") || "").trim();

    if (!pattern) {
      setNotice("路由模式不能为空");
      renderApp();
      return;
    }

    state.workersPendingKey = "route";
    renderApp();

    const requestScope = captureRequestContext(readWorkerRouteContext);

    try {
      await createWorkerRoute(activeWorkerName(), {
        zoneId,
        zoneName: zoneName(zoneId),
        pattern,
      });
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice("路由已添加");
      await loadWorkerRoutes({ render: false });
      if (!requestScope.isCurrent()) {
        return;
      }
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersPendingKey = "";
        renderApp();
      }
    }
  }

  async function submitWorkerPreferredRoute(event) {
    event.preventDefault();
    const formData = readForm("#worker-preferred-route-form");
    const zoneId = String(formData.get("zoneId") || selectedPreferredZoneId());
    const rawPattern = String(formData.get("pattern") || "");
    const rawPreferredHostname = String(formData.get("preferredHostname") || "");
    const pattern = normalizePreferredPattern(rawPattern);
    const preferredHostname = rawPreferredHostname.trim().toLowerCase();

    state.workersPreferredPattern = rawPattern;
    state.workersPreferredHostname = rawPreferredHostname;

    if (!pattern) {
      setNotice("访问域名不能为空");
      renderApp();
      return;
    }

    if (!preferredHostname) {
      setNotice("优选域名不能为空");
      renderApp();
      return;
    }

    state.workersPendingKey = "preferred-route";
    renderApp();

    const requestScope = captureRequestContext(readWorkerPreferredContext);

    try {
      const deployment = await createWorkerPreferredRoute(activeWorkerName(), {
        zoneId,
        zoneName: zoneName(zoneId),
        pattern,
        preferredHostname,
      });
      if (!requestScope.isCurrent()) {
        return;
      }
      state.workersRouteZoneId = zoneId;
      state.workersPreferredZoneId = zoneId;
      state.workersPreferredPattern = "";
      state.workersPreferredHostname = deployment.preferredHostname || preferredHostname;
      setNotice(`Worker 优选已添加：${deployment.routePattern}，CNAME 指向 ${deployment.preferredHostname}`);
      await loadWorkerRoutes({ render: false });
      if (!requestScope.isCurrent()) {
        return;
      }
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersPendingKey = "";
        renderApp();
      }
    }
  }

  async function deleteWorkerRoute(routeId) {
    if (!routeId || !window.confirm("确定要删除这个路由吗？")) {
      return;
    }

    state.workersPendingKey = "route";
    renderApp();

    const requestScope = captureRequestContext(readWorkerRouteContext);

    try {
      await removeWorkerRoute(activeWorkerName(), routeId, selectedRouteZoneId());
      if (!requestScope.isCurrent()) {
        return;
      }
      state.workersRoutes = state.workersRoutes.filter((route) => route.id !== routeId);
      setNotice("路由已删除");
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersPendingKey = "";
        renderApp();
      }
    }
  }

  async function submitWorkerDomain(event) {
    event.preventDefault();
    const formData = readForm("#worker-domain-form");
    const zoneId = String(formData.get("zoneId") || selectedDomainZoneId());
    const hostname = String(formData.get("hostname") || "").trim();

    if (!hostname) {
      setNotice("自定义域不能为空");
      renderApp();
      return;
    }

    state.workersPendingKey = "domain";
    renderApp();

    const requestScope = captureRequestContext(readWorkerDomainContext);

    try {
      const domain = await createWorkerDomain(activeWorkerName(), {
        accountId: activeAccountId(),
        zoneId,
        zoneName: zoneName(zoneId),
        hostname,
      });
      if (!requestScope.isCurrent()) {
        return;
      }
      state.workersActiveDetail = {
        ...state.workersActiveDetail,
        domains: [domain, ...(state.workersActiveDetail?.domains || [])],
      };
      await loadWorkers();
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice("自定义域已添加");
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersPendingKey = "";
        renderApp();
      }
    }
  }

  async function deleteWorkerDomain(domainId) {
    if (!domainId || !window.confirm("确定要删除这个自定义域吗？")) {
      return;
    }

    state.workersPendingKey = "domain";
    renderApp();

    const requestScope = captureRequestContext(readWorkerContext);

    try {
      await removeWorkerDomain(activeWorkerName(), domainId, activeAccountId());
      if (!requestScope.isCurrent()) {
        return;
      }
      state.workersActiveDetail = {
        ...state.workersActiveDetail,
        domains: (state.workersActiveDetail?.domains || []).filter(
          (domain) => domain.id !== domainId
        ),
      };
      await loadWorkers();
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice("自定义域已删除");
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersPendingKey = "";
        renderApp();
      }
    }
  }

  function requestDeleteWorker(workerName) {
    workerDetailRevision += 1;
    state.workersModal = "delete";
    state.workersDeleteName = workerName;
    state.workersDeleteConfirm = "";
    state.workersNotice = "";
    renderApp();
  }

  function updateWorkerDeleteConfirm(event) {
    state.workersDeleteConfirm = String(event.target.value || "");
    const button = document.querySelector("#worker-delete-confirm");

    if (button) {
      button.disabled =
        state.workersDeleteConfirm !== state.workersDeleteName || state.workersSaving;
    }
  }

  async function confirmDeleteWorker() {
    if (state.workersDeleteConfirm !== state.workersDeleteName) {
      return;
    }

    state.workersSaving = true;
    renderApp();

    let requestScope = captureRequestContext(readWorkerDeleteContext);
    const deletedName = state.workersDeleteName;

    try {
      await removeWorker(deletedName, activeAccountId());
      if (!requestScope.isCurrent()) {
        return;
      }
      resetModalState();
      requestScope = captureRequestContext(readWorkerContext);
      await loadWorkers();
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(`Worker "${deletedName}" 已删除`);
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      setNotice(error.message);
    } finally {
      if (requestScope.isCurrent()) {
        state.workersSaving = false;
        renderApp();
      }
    }
  }

  return {
    changeWorkerDomainZone,
    changeWorkerPreferredDraft,
    changeWorkerPreferredZone,
    changeWorkerRouteZone,
    changeWorkersAccount,
    changeWorkerTab,
    closeWorkersModal,
    confirmDeleteWorker,
    deleteWorkerSecret,
    deleteWorkerDomain,
    deleteWorkerRoute,
    ensureWorkersLoaded,
    loadWorkerRoutes,
    loadWorkers,
    openCreateWorkerModal,
    openEditWorker,
    requestDeleteWorker,
    submitCreateWorker,
    submitWorkerDomain,
    submitWorkerBinding,
    submitWorkerSecret,
    submitWorkerSchedules,
    submitWorkerPreferredRoute,
    submitWorkerRoute,
    submitWorkerScript,
    openWorkerTail,
    toggleWorkerSubdomain,
    updateWorkerDeleteConfirm,
  };
}
