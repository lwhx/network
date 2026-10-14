import { state } from "../state.js";
import { escapeHtml } from "../utils.js";

const labels = { running: "执行中", recovering: "恢复中", completed: "部署完成", rolled_back: "已恢复", manual_needed: "待人工核查", manual_resolved: "已确认人工处理" };
const classifications = { restored: "已恢复原配置", original: "与原配置一致", applied: "与本任务修改一致", unknown_write: "写入结果未确认",
  unconfirmed_creation: "新建资源归属未确认", external_change: "配置已被其他操作修改", unreadable: "暂时无法读取现状" };
const stepStatuses = { restored: "已恢复原配置", unchanged: "与原配置一致", rejected: "请求已拒绝", confirmed: "已确认本次修改", pending: "写入结果未确认", rollback_pending: "恢复结果未确认" };
const date = (value) => value ? new Date(value).toLocaleString("zh-CN") : "-";
const taskLabel = (task) => task.kind === "deletion" && task.status === "completed" ? "删除完成" : labels[task.status] || task.status;

export function renderSpeedTasks() {
  const task = state.speedTaskDetail;
  const busy = Boolean(state.speedTaskActionId);
  return `<section class="speed-card speed-task-panel" aria-label="加速任务记录">
    <div class="speed-task-heading"><div><h2>加速任务记录</h2><p>重启后保留任务步骤。先检查现状，再恢复或记录人工处理结果。</p></div>
      <button class="speed-outline-button" type="button" id="speed-tasks-refresh" ${state.speedTasksLoading || busy ? "disabled" : ""}>刷新任务</button></div>
    ${state.speedTasksNotice ? `<div class="notice" role="status">${escapeHtml(state.speedTasksNotice)}</div>` : ""}
    ${state.speedTasksLoading && !state.speedTasks.length ? '<p>正在读取任务记录...</p>' : ""}
    <div class="speed-task-list">${state.speedTasks.map((item) => `<article class="speed-task-row">
      <div><strong>${escapeHtml(item.accessDomain)}</strong><span>${escapeHtml(item.zoneName)} · ${escapeHtml(date(item.createdAt))}</span></div>
      <span class="speed-task-status ${item.status === "manual_needed" ? "warning" : ""}">${escapeHtml(taskLabel(item))}</span>
      <button class="speed-outline-button speed-task-inspect" type="button" data-task-id="${escapeHtml(item.id)}" ${busy ? "disabled" : ""}>检查任务</button></article>`).join("") || (!state.speedTasksLoading ? "<p>暂无加速任务记录。</p>" : "")}</div>
    ${state.speedTaskDetailLoading ? '<p>正在比对远端配置...</p>' : ""}
    ${task ? `<section class="speed-task-detail" aria-label="加速任务详情">
      <div class="speed-task-heading"><h3>${escapeHtml(task.accessDomain)} · ${escapeHtml(taskLabel(task))}</h3>
        <button class="ghost-button" id="speed-task-detail-close" type="button" ${busy ? "disabled" : ""}>关闭详情</button></div>
      ${task.steps.map((step) => `<div class="speed-task-step"><strong>${escapeHtml(step.resource)}</strong><span>${escapeHtml(classifications[step.classification] || stepStatuses[step.status] || "未确认")}</span></div>`).join("") || "<p>任务未发送配置写入。</p>"}
      ${task.error ? `<p class="notice">${escapeHtml(task.error)}</p>` : ""}
      ${task.recoverable ? `<p>恢复会逐项检查配置；未确认写入和外部改动需要人工核查。人工确认会解除区域锁定，请先在 Cloudflare 完成核查和处理。</p>
        ${task.kind === "deletion" ? "<p>这是删除任务，请在 Cloudflare 核查剩余资源并人工处理；面板不会重建已删除的资源。</p>" : ""}
        <div class="speed-task-actions">${task.kind !== "deletion" ? `<button class="primary-button" id="speed-task-recover" type="button" ${busy ? "disabled" : ""}>${busy ? "处理中..." : "恢复原配置"}</button>` : ""}
        <button class="secondary-button" id="speed-task-resolve" type="button" ${busy || task.steps.some((step) => step.classification === "unreadable") ? "disabled" : ""}>确认已人工处理</button></div>` : ""}
    </section>` : ""}
  </section>`;
}
