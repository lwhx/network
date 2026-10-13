import { state } from "../state.js";
import { escapeHtml } from "../utils.js";

export function renderDnsBulkResults() {
  const report = state.dnsBulkResult;
  if (!report || report.zoneId !== state.selectedZone?.id || report.accountId !== state.activeCloudflareAccountId) return "";
  const labels = { success: "成功", failed: "失败", unknown: "结果未确认", skipped: "未执行" };
  const busy = state.savingDnsBulk || state.deletingDnsBulk;
  return `<section class="panel dns-bulk-results" aria-label="批量操作结果">
    <div class="dns-record-title"><h2>批量${report.type === "create" ? "添加" : "删除"}结果</h2>
      <button type="button" class="secondary-button" id="dns-bulk-retry" ${busy || !report.results.some((item) => item.retryable) ? "disabled" : ""}>仅重试失败和未执行项</button></div>
    ${report.summary.unknown ? '<p class="notice">部分操作结果未确认，请刷新 DNS 记录并核查。这些项目不会自动重试，以免重复操作。</p>' : ""}
    <div class="table-wrap"><table><thead><tr><th>序号</th><th>记录</th><th>结果</th><th>说明</th></tr></thead><tbody>
      ${report.results.map((item) => `<tr><td>${item.index + 1}</td><td>${escapeHtml(item.input ? `${item.input.type} ${item.input.name}` : item.recordId)}</td><td>${labels[item.status] || "未确认"}</td><td>${escapeHtml(item.error || "已确认完成")}</td></tr>`).join("")}
    </tbody></table></div></section>`;
}
