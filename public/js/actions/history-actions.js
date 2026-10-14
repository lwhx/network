import { clearOperationHistory, fetchOperationHistory } from "../api.js";
import { state } from "../state.js";
import { beginScopedRequest, captureRequestContext } from "../request-scope.js";

function historyQuery() {
  const time = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : value || "";
  return {
    limit: state.operationHistoryLimit,
    module: state.operationHistoryModule,
    status: state.operationHistoryStatus,
    accountId: state.operationHistoryAccountId,
    zoneId: state.operationHistoryZoneId,
    from: time(state.operationHistoryFrom),
    to: time(state.operationHistoryTo),
    offset: state.operationHistoryOffset,
  };
}

function applyHistoryPayload(payload = {}) {
  state.operationHistory = Array.isArray(payload.entries) ? payload.entries : [];
  state.operationHistoryFilters = {
    modules: Array.isArray(payload.filters?.modules) ? payload.filters.modules : [],
    statuses: Array.isArray(payload.filters?.statuses) ? payload.filters.statuses : [],
    accounts: Array.isArray(payload.filters?.accounts) ? payload.filters.accounts : [],
    zones: Array.isArray(payload.filters?.zones) ? payload.filters.zones : [],
  };
  state.operationHistoryTotal = Number(payload.total) || 0;
  state.operationHistoryFilteredTotal = Number(payload.filteredTotal ?? payload.total) || 0;
}

function readHistoryContext() {
  return JSON.stringify([state.view, state.mainSection, historyQuery()]);
}

export function createHistoryActions({ renderApp }) {
  async function loadOperationHistory(notice = "") {
    state.operationHistoryLoading = true;
    state.operationHistoryNotice = notice;
    renderApp();

    const requestScope = beginScopedRequest("history:loadOperationHistory", readHistoryContext);

    try {
      const payload = await fetchOperationHistory(historyQuery());
      if (!requestScope.isCurrent()) {
        return;
      }
      applyHistoryPayload(payload);
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      state.operationHistoryNotice = error.message;
    } finally {
      if (requestScope.isCurrent()) {
        state.operationHistoryLoading = false;
        renderApp();
      }
    }
  }

  async function ensureOperationHistoryLoaded() {
    if (state.view !== "domains" || state.mainSection !== "history") {
      return;
    }

    await loadOperationHistory();
  }

  async function changeOperationHistoryFilter(event) {
    const field = event.target.dataset.historyFilter;
    const value = String(event.target.value || "");

    if (field === "module") {
      state.operationHistoryModule = value;
    } else if (field === "status") {
      state.operationHistoryStatus = value;
    } else if (field === "limit") {
      state.operationHistoryLimit = value;
    } else if (["accountId", "zoneId", "from", "to"].includes(field)) {
      const keys = { accountId: "operationHistoryAccountId", zoneId: "operationHistoryZoneId", from: "operationHistoryFrom", to: "operationHistoryTo" };
      state[keys[field]] = value;
      if (field === "accountId") state.operationHistoryZoneId = "";
    }
    state.operationHistoryOffset = 0;

    await loadOperationHistory();
  }

  async function clearOperationHistoryAction() {
    if (typeof window !== "undefined" && window.confirm && !window.confirm("确定清空所有账号的操作历史吗？加速任务和配置快照会保留。")) return;
    state.operationHistoryLoading = true;
    state.operationHistoryNotice = "";
    renderApp();

    const requestScope = captureRequestContext(readHistoryContext);

    try {
      const result = await clearOperationHistory();
      if (!requestScope.isCurrent()) {
        return;
      }
      state.operationHistoryOffset = 0;
      await loadOperationHistory(`已清空 ${result.deleted || 0} 条操作记录`);
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      state.operationHistoryNotice = error.message;
      state.operationHistoryLoading = false;
      renderApp();
    }
  }

  return {
    previousHistoryPage: async () => {
      state.operationHistoryOffset = Math.max(0, state.operationHistoryOffset - Number(state.operationHistoryLimit));
      await loadOperationHistory();
    },
    nextHistoryPage: async () => {
      if (state.operationHistoryOffset + state.operationHistory.length >= state.operationHistoryFilteredTotal) return;
      state.operationHistoryOffset += Number(state.operationHistoryLimit);
      await loadOperationHistory();
    },
    changeOperationHistoryFilter,
    clearOperationHistory: clearOperationHistoryAction,
    ensureOperationHistoryLoaded,
    loadOperationHistory,
  };
}
