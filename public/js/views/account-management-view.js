import { state } from "../state.js";
import { escapeHtml } from "../utils.js";

export function renderAccountManagementDialog() {
  if (!state.accountManagerOpen) return "";
  const account = state.accountManagerEdit;
  const busy = state.accountManagerBusy;
  const disabled = busy ? "disabled" : "";
  return `<div class="account-dialog-backdrop"><section class="account-dialog account-manager" role="dialog" aria-modal="true" aria-label="Cloudflare 账号管理">
    <div class="account-dialog-head"><div><h2>Cloudflare 账号管理</h2><p>编辑账号信息、更新密钥或测试连接。</p></div>
      <button type="button" class="ghost-button account-manager-close" ${disabled}>关闭</button></div>
    <div class="account-manager-list">${state.cloudflareAccounts.map((item) => `<div class="account-manager-row">
      <div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.email)}${item.id === state.activeCloudflareAccountId ? " · 当前账号" : ""}</span></div>
      <div class="account-manager-row-actions"><button class="ghost-button cloudflare-account-edit" type="button" data-account-id="${escapeHtml(item.id)}" ${disabled}>编辑</button>
        <button class="danger-button cloudflare-account-delete" type="button" data-account-id="${escapeHtml(item.id)}" ${disabled}>删除</button></div></div>`).join("")}</div>
    ${account ? `<form class="account-dialog-form" id="cloudflare-account-edit-form">
      <label class="account-dialog-field"><span>账号名称</span><input name="cloudflareName" type="text" value="${escapeHtml(account.name)}" maxlength="128" ${disabled} /></label>
      <label class="account-dialog-field"><span>Cloudflare 登录邮箱</span><input name="cfEmail" type="email" value="${escapeHtml(account.email)}" required ${disabled} /></label>
      <label class="account-dialog-field"><span>新的 Global API Key（留空保留现有密钥）</span><input name="cfApiKey" type="password" autocomplete="new-password" placeholder="留空保留现有密钥" ${disabled} /></label>
      <div class="account-dialog-actions"><button id="cloudflare-account-test" type="button" class="secondary-button" ${disabled}>测试连接</button>
        <button type="submit" class="primary-button" ${disabled}>${busy ? "处理中..." : "保存账号"}</button></div></form>` : ""}
    ${state.accountManagerNotice ? `<div class="notice" role="status">${escapeHtml(state.accountManagerNotice)}</div>` : ""}
    </section></div>`;
}
