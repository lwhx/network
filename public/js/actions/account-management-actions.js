import { fetchManagedCloudflareAccount, updateManagedCloudflareAccount, deleteManagedCloudflareAccount, testManagedCloudflareAccount } from "../api.js";
import { beginScopedRequest, captureRequestContext } from "../request-scope.js";
import { state, resetCloudflareAccountData } from "../state.js";
import { applySession } from "./session-actions.js";

function readForm() {
  const data = new FormData(document.querySelector("#cloudflare-account-edit-form"));
  return Object.fromEntries(["cloudflareName", "cfEmail", "cfApiKey"].map((name) => [name, String(data.get(name) || "").trim()]));
}

function restoreForm(input) {
  const form = document.querySelector("#cloudflare-account-edit-form");
  for (const [name, value] of Object.entries(input)) {
    const field = form?.querySelector(`[name="${name}"]`);
    if (field) field.value = value;
  }
}

export function createAccountManagementActions({ renderApp, loadZones }) {
  function openAccountManager() {
    state.accountManagerOpen = true;
    state.accountManagerEdit = null;
    state.accountManagerNotice = "";
    renderApp();
  }

  function closeAccountManager() {
    if (state.accountManagerBusy) return;
    state.accountManagerOpen = false;
    state.accountManagerEdit = null;
    state.accountManagerNotice = "";
    renderApp();
  }

  async function editManagedCloudflareAccount(accountId) {
    if (state.accountManagerBusy) return;
    const request = beginScopedRequest("account-detail", () => state.accountManagerOpen);
    state.accountManagerBusy = true;
    state.accountManagerEdit = null;
    state.accountManagerNotice = "";
    renderApp();
    try {
      const payload = await fetchManagedCloudflareAccount(accountId, { signal: request.signal });
      if (request.isCurrent()) state.accountManagerEdit = payload.account;
    } catch (error) {
      if (request.isCurrent()) state.accountManagerNotice = error.message;
    } finally {
      if (request.isCurrent()) { state.accountManagerBusy = false; renderApp(); }
    }
  }

  async function saveManagedCloudflareAccount(event) {
    event.preventDefault();
    if (state.accountManagerBusy || !state.accountManagerEdit) return;
    const accountId = state.accountManagerEdit.id;
    const input = readForm();
    const request = captureRequestContext(() => "", { navigation: false });
    const dialog = captureRequestContext(() => state.accountManagerOpen);
    state.accountManagerBusy = true;
    state.accountManagerNotice = "";
    renderApp(); restoreForm(input);
    try {
      const session = await updateManagedCloudflareAccount(accountId, input);
      if (!request.isCurrent()) return;
      const keepDialog = dialog.isCurrent();
      const refresh = accountId === state.activeCloudflareAccountId;
      if (keepDialog) { state.accountManagerBusy = false; state.accountManagerEdit = null; }
      applySession(session);
      if (keepDialog) state.accountManagerNotice = "账号已保存。";
      if (refresh) {
        resetCloudflareAccountData({ preserveAccountManager: keepDialog });
        history.replaceState(null, "", location.pathname);
        await loadZones({ throwOnError: false });
      }
    } catch (error) {
      if (!dialog.isCurrent()) return;
      state.accountManagerNotice = error.message;
    } finally {
      if (dialog.isCurrent()) {
        state.accountManagerBusy = false;
        renderApp();
        if (state.accountManagerEdit) restoreForm(input);
      }
    }
  }

  async function testManagedCloudflareAccountAction() {
    if (state.accountManagerBusy || !state.accountManagerEdit) return;
    const accountId = state.accountManagerEdit.id;
    const input = readForm();
    const request = captureRequestContext(() => `${state.accountManagerOpen}:${state.accountManagerEdit?.id || ""}`);
    state.accountManagerBusy = true;
    state.accountManagerNotice = "正在测试连接...";
    renderApp(); restoreForm(input);
    try {
      const result = await testManagedCloudflareAccount(accountId, input);
      if (request.isCurrent()) state.accountManagerNotice = result.message;
    } catch (error) {
      if (request.isCurrent()) state.accountManagerNotice = error.message;
    } finally {
      if (request.isCurrent()) { state.accountManagerBusy = false; renderApp(); restoreForm(input); }
    }
  }

  async function deleteManagedCloudflareAccountAction(accountId) {
    const account = state.cloudflareAccounts.find((item) => item.id === accountId);
    if (!account || state.accountManagerBusy || !window.confirm(`确定删除账号“${account.name}”吗？只会移除面板中的凭据，Cloudflare 上的域名和资源会保留。`)) return;
    const request = captureRequestContext(() => "", { navigation: false });
    const dialog = captureRequestContext(() => state.accountManagerOpen);
    state.accountManagerBusy = true;
    state.accountManagerNotice = "";
    renderApp();
    try {
      const session = await deleteManagedCloudflareAccount(accountId);
      if (!request.isCurrent()) return;
      const keepDialog = dialog.isCurrent();
      const changed = session.activeCloudflareAccount?.id !== state.activeCloudflareAccountId;
      if (keepDialog) { state.accountManagerBusy = false; state.accountManagerEdit = null; }
      applySession(session);
      if (keepDialog) state.accountManagerNotice = "账号已删除。";
      if (changed || !session.hasCredentials) {
        resetCloudflareAccountData({ preserveAccountManager: keepDialog && Boolean(session.hasCredentials) });
        history.replaceState(null, "", location.pathname);
        state.connected = Boolean(session.authenticated && session.hasCredentials);
        if (!state.connected) state.accountManagerOpen = false;
        renderApp();
        if (state.connected) await loadZones({ throwOnError: false });
      }
    } catch (error) {
      if (!dialog.isCurrent()) return;
      state.accountManagerNotice = error.message;
    } finally {
      if (dialog.isCurrent()) { state.accountManagerBusy = false; renderApp(); }
    }
  }

  return { openAccountManager, closeAccountManager, editManagedCloudflareAccount, saveManagedCloudflareAccount,
    testManagedCloudflareAccount: testManagedCloudflareAccountAction, deleteManagedCloudflareAccount: deleteManagedCloudflareAccountAction };
}
