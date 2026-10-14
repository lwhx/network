import { icon } from "../icons.js";
import { state } from "../state.js";
import { escapeHtml } from "../utils.js";
import { renderShell } from "./shell-view.js";

const statusLabels = {
  failed: "失败",
  success: "成功",
  partial: "部分成功",
  unknown: "结果未确认",
};

function formatDate(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("zh-CN");
}

function renderModuleOptions() {
  return state.operationHistoryFilters.modules
    .map(
      (module) => `
        <option value="${escapeHtml(module)}" ${module === state.operationHistoryModule ? "selected" : ""}>
          ${escapeHtml(module)}
        </option>
      `
    )
    .join("");
}

function renderRows() {
  if (state.operationHistoryLoading && state.operationHistory.length === 0) {
    return `
      <div class="history-empty">
        <span class="spinner" aria-hidden="true"></span>
        <strong>正在读取操作历史</strong>
      </div>
    `;
  }

  if (state.operationHistory.length === 0) {
    return `
      <div class="history-empty">
        <span class="history-empty-icon">${icon("history")}</span>
        <strong>暂无操作记录</strong>
        <p>执行 DNS、SSL、缓存、防火墙、Workers 或资源管理操作后会显示在这里。</p>
      </div>
    `;
  }

  return `
    <div class="history-table">
      <div class="history-row history-head">
        <span>时间</span>
        <span>账号 / 域名</span>
        <span>模块</span>
        <span>动作</span>
        <span>资源</span>
        <span>结果</span>
        <span>耗时</span>
      </div>
      ${state.operationHistory
        .map(
          (entry) => `
            <div class="history-row">
              <span class="history-time">${escapeHtml(formatDate(entry.createdAt))}</span>
              <span class="history-resource" title="${escapeHtml(entry.zoneId || "")}">${escapeHtml(entry.accountName || entry.accountId || "-")}<small>${escapeHtml(entry.zoneName || entry.zoneId || "-")}</small></span>
              <span>${escapeHtml(entry.module)}</span>
              <span>
                <em class="history-method">${escapeHtml(entry.method)}</em>
                ${escapeHtml(entry.action)}
              </span>
              <span class="history-resource" title="${escapeHtml(entry.path)}">
                ${escapeHtml(entry.resource || entry.path)}
              </span>
              <span>
                <em class="history-status ${escapeHtml(entry.status)}">
                  ${escapeHtml(statusLabels[entry.status] || entry.status)}
                </em>
                ${
                  entry.error
                    ? `<small title="${escapeHtml(entry.error)}">${escapeHtml(entry.error)}</small>`
                    : ""
                }
              </span>
              <span>${escapeHtml(entry.durationMs)}ms</span>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

export function renderHistoryView() {
  const successCount = state.operationHistory.filter((entry) => entry.status === "success").length;
  const failedCount = state.operationHistory.filter((entry) => entry.status === "failed").length;

  renderShell(`
    <section class="history-content">
      <div class="history-scroll-shell">
        <section class="history-card history-toolbar">
          <div>
            <h2>操作历史</h2>
            <p>操作摘要保存在 SQLite，重启后继续保留；不保存请求体和敏感字段。</p>
          </div>
          <div class="history-toolbar-actions">
            <button class="history-outline-button" id="history-refresh" type="button" ${state.operationHistoryLoading ? "disabled" : ""}>
              ${icon("refresh")}
              刷新
            </button>
            <button class="history-danger-button" id="history-clear" type="button" ${state.operationHistoryLoading || state.operationHistory.length === 0 ? "disabled" : ""}>
              ${icon("trash")}
              清空
            </button>
          </div>
        </section>

        <section class="history-summary-grid">
          <div class="history-summary-card">
            <span>当前显示 / 符合筛选</span>
            <strong>${escapeHtml(state.operationHistory.length)} / ${escapeHtml(state.operationHistoryFilteredTotal)}</strong>
          </div>
          <div class="history-summary-card">
            <span>成功</span>
            <strong>${escapeHtml(successCount)}</strong>
          </div>
          <div class="history-summary-card">
            <span>失败</span>
            <strong>${escapeHtml(failedCount)}</strong>
          </div>
          <div class="history-summary-card">
            <span>筛选模块</span>
            <strong>${escapeHtml(state.operationHistoryModule || "全部")}</strong>
          </div>
        </section>

        <section class="history-card history-filter-card">
          <label><span>账号</span><select data-history-filter="accountId" ${state.operationHistoryLoading ? "disabled" : ""}>
            <option value="">全部账号</option>${(state.operationHistoryFilters.accounts || []).map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === state.operationHistoryAccountId ? "selected" : ""}>${escapeHtml(account.name || account.id)}</option>`).join("")}</select></label>
          <label><span>域名</span><select data-history-filter="zoneId" ${state.operationHistoryLoading ? "disabled" : ""}>
            <option value="">全部域名</option>${(state.operationHistoryFilters.zones || []).filter((zone) => !state.operationHistoryAccountId || zone.accountId === state.operationHistoryAccountId).map((zone) => `<option value="${escapeHtml(zone.id)}" ${zone.id === state.operationHistoryZoneId ? "selected" : ""}>${escapeHtml(zone.name || zone.id)}</option>`).join("")}</select></label>
          <label>
            <span>模块</span>
            <select data-history-filter="module" ${state.operationHistoryLoading ? "disabled" : ""}>
              <option value="">全部模块</option>
              ${renderModuleOptions()}
            </select>
          </label>
          <label>
            <span>结果</span>
            <select data-history-filter="status" ${state.operationHistoryLoading ? "disabled" : ""}>
              <option value="">全部结果</option>
              <option value="success" ${state.operationHistoryStatus === "success" ? "selected" : ""}>成功</option>
              <option value="failed" ${state.operationHistoryStatus === "failed" ? "selected" : ""}>失败</option>
              <option value="partial" ${state.operationHistoryStatus === "partial" ? "selected" : ""}>部分成功</option>
              <option value="unknown" ${state.operationHistoryStatus === "unknown" ? "selected" : ""}>结果未确认</option>
            </select>
          </label>
          <label>
            <span>条数</span>
            <select data-history-filter="limit" ${state.operationHistoryLoading ? "disabled" : ""}>
              ${["20", "50", "80", "150", "300"]
                .map(
                  (limit) => `
                    <option value="${limit}" ${state.operationHistoryLimit === limit ? "selected" : ""}>
                      ${limit} 条
                    </option>
                  `
                )
                .join("")}
            </select>
          </label>
          <label><span>开始时间</span><input type="datetime-local" data-history-filter="from" value="${escapeHtml(state.operationHistoryFrom)}" ${state.operationHistoryLoading ? "disabled" : ""} /></label>
          <label><span>结束时间</span><input type="datetime-local" data-history-filter="to" value="${escapeHtml(state.operationHistoryTo)}" ${state.operationHistoryLoading ? "disabled" : ""} /></label>
        </section>

        ${state.operationHistoryNotice ? `<div class="history-notice">${escapeHtml(state.operationHistoryNotice)}</div>` : ""}

        <section class="history-card history-list-card">
          <div class="history-card-heading">
            <div>
              <h2>最近操作</h2>
              <p>最多保留最近 3000 条摘要；清空历史不会删除加速任务或配置快照。</p>
            </div>
            ${state.operationHistoryLoading ? `<span class="spinner" aria-hidden="true"></span>` : ""}
          </div>
          ${renderRows()}
          <div class="history-pagination"><span>第 ${Math.floor(state.operationHistoryOffset / Number(state.operationHistoryLimit)) + 1} 页</span>
            <button class="history-outline-button" type="button" id="history-previous" ${state.operationHistoryLoading || !state.operationHistoryOffset ? "disabled" : ""}>上一页</button>
            <button class="history-outline-button" type="button" id="history-next" ${state.operationHistoryLoading || state.operationHistoryOffset + state.operationHistory.length >= state.operationHistoryFilteredTotal ? "disabled" : ""}>下一页</button></div>
        </section>
      </div>
    </section>
  `);
}
