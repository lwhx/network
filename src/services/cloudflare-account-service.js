import { HttpError } from "../lib/http-error.js";

function maskEmail(email) {
  const [name = "", domain = ""] = String(email).split("@");

  if (!name || !domain) {
    return "";
  }

  const visible = name.length <= 2 ? name.slice(0, 1) : name.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(3, name.length - visible.length))}@${domain}`;
}

function normalizeAccount(account) {
  if (!account) {
    return null;
  }

  const email = String(account.email || "").trim();
  const globalApiKey = String(account.globalApiKey || "").trim();

  if (!email || !globalApiKey) {
    return null;
  }

  const id = String(account.id || "").trim();
  const name = String(account.name || account.label || "").trim();

  if (!id) {
    return null;
  }

  return {
    email,
    globalApiKey,
    id,
    name: name || maskEmail(email),
    source: account.source || "env",
  };
}

export { maskEmail };

export class CloudflareAccountService {
  constructor({ store } = {}) {
    this.store = store;
  }

  listAccounts() {
    return (this.store?.listCloudflareAccounts() || []).map(normalizeAccount).filter(Boolean);
  }

  hasAccounts() {
    return Boolean(this.store?.hasCloudflareAccounts());
  }

  listSafe(activeAccountId = "") {
    return this.listAccounts().map((account) => ({
      active: account.id === activeAccountId,
      email: maskEmail(account.email),
      id: account.id,
      name: account.name,
      source: account.source,
    }));
  }

  getDefaultAccount() {
    return normalizeAccount(this.store?.getCloudflareAccount()) || null;
  }

  getAccount(accountId = "") {
    if (accountId) {
      return normalizeAccount(this.store?.getCloudflareAccount(accountId));
    }

    return this.getDefaultAccount();
  }

  findAccount(accountId = "") {
    const id = String(accountId || "").trim();
    return id ? normalizeAccount(this.store?.getCloudflareAccount(id)) : null;
  }

  hasAccount(accountId = "") {
    return Boolean(this.findAccount(accountId));
  }

  getSafeAccount(accountId = "") {
    const account = this.getAccount(accountId);

    if (!account) {
      return null;
    }

    return {
      email: maskEmail(account.email),
      id: account.id,
      name: account.name,
      source: account.source,
    };
  }

  getEditableAccount(accountId) {
    const account = this.findAccount(accountId);
    if (!account) return null;
    return {
      email: account.email,
      hasApiKey: Boolean(account.globalApiKey),
      id: account.id,
      name: account.name,
      source: account.source,
    };
  }

  prepareUpdate(accountId, input = {}) {
    const existing = this.findAccount(accountId);
    if (!existing) throw new HttpError(404, "Cloudflare 账号不存在。");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new HttpError(400, "请输入有效的 Cloudflare 账号信息。");
    }
    for (const field of ["cloudflareName", "cfEmail", "cfApiKey"]) {
      if (Object.hasOwn(input, field) && typeof input[field] !== "string") {
        throw new HttpError(400, "Cloudflare 账号信息必须是文本。");
      }
    }
    const email = Object.hasOwn(input, "cfEmail") ? input.cfEmail.trim().toLowerCase() : existing.email;
    const globalApiKey = input.cfApiKey?.trim() || existing.globalApiKey;
    const name = Object.hasOwn(input, "cloudflareName") ? input.cloudflareName.trim() || maskEmail(email) : existing.name;
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpError(400, "请输入有效的 Cloudflare 登录邮箱。");
    }
    if (globalApiKey.length < 8 || globalApiKey.length > 256) {
      throw new HttpError(400, "请输入有效的 Cloudflare Global API Key。");
    }
    if (name.length > 128) throw new HttpError(400, "Cloudflare 账号名称不能超过 128 个字符。");
    return { ...existing, email, globalApiKey, name };
  }

  updateAccount(accountId, input, { authorize = () => {} } = {}) {
    return this.store.runSetupTransaction(() => {
      authorize();
      const candidate = this.prepareUpdate(accountId, input);
      if (this.listAccounts().some((account) => account.id !== candidate.id && account.email.toLowerCase() === candidate.email)) {
        throw new HttpError(409, "该 Cloudflare 登录邮箱已存在。");
      }
      this.store.updateCloudflareAccount(candidate.id, candidate);
      return this.getEditableAccount(candidate.id);
    });
  }

  deleteAccount(accountId, { authorize = () => {}, onDeleted = () => {} } = {}) {
    return this.store.runSetupTransaction(() => {
      authorize();
      const account = this.findAccount(accountId);
      if (!account) throw new HttpError(404, "Cloudflare 账号不存在。");
      this.store.deleteCloudflareAccount(account.id);
      onDeleted();
      return true;
    });
  }

  getCredentials(accountId = "") {
    const account = this.getAccount(accountId);

    if (!account) {
      return { email: "", globalApiKey: "" };
    }

    return {
      accountId: account.id,
      email: account.email,
      globalApiKey: account.globalApiKey,
      source: account.source,
    };
  }

  resolveSelectedAccountId(accountId = "") {
    if (accountId && this.hasAccount(accountId)) {
      return accountId;
    }

    return this.getDefaultAccount()?.id || "";
  }
}
