import { clearOperationHistory, fetchOperationHistory } from "../api.js";
import { state } from "../state.js";
import { beginScopedRequest, captureRequestContext } from "../request-scope.js";

function historyQuery() {
  return {
    limit: state.operationHistoryLimit,
    module: state.operationHistoryModule,
    status: state.operationHistoryStatus,
  };
}

function applyHistoryPayload(payload = {}) {
  state.operationHistory = Array.isArray(payload.entries) ? payload.entries : [];
  state.operationHistoryFilters = {
    modules: Array.isArray(payload.filters?.modules) ? payload.filters.modules : [],
    statuses: Array.isArray(payload.filters?.statuses) ? payload.filters.statuses : [],
  };
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
    }

    await loadOperationHistory();
  }

  async function clearOperationHistoryAction() {
    state.operationHistoryLoading = true;
    state.operationHistoryNotice = "";
    renderApp();

    const requestScope = captureRequestContext(readHistoryContext);

    try {
      const result = await clearOperationHistory();
      if (!requestScope.isCurrent()) {
        return;
      }
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
    changeOperationHistoryFilter,
    clearOperationHistory: clearOperationHistoryAction,
    ensureOperationHistoryLoaded,
    loadOperationHistory,
  };
}
