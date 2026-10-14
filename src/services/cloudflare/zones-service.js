import { readCloudflareList } from "./cloudflare-list-reader.js";
import { HttpError } from "../../lib/http-error.js";
import { assertCloudflareResourceId } from "./cloudflare-id.js";
import { normalizeCloudflareZone } from "./zone-normalizer.js";

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function normalizeDomainName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, "")
    .split(/[/?#]/)[0]
    .replace(/\.$/, "");
}

function assertDomainName(value) {
  const name = normalizeDomainName(value);

  if (!domainPattern.test(name)) {
    throw new HttpError(400, "域名格式无效，请输入 example.com 这样的一级域名");
  }

  return name;
}

function normalizeAccount(account = {}) {
  return {
    id: account.id || "",
    name: account.name || account.id || "Cloudflare Account",
  };
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value || "").trim().toLowerCase();

  return ["1", "true", "yes", "on"].includes(normalized);
}

export class ZonesService {
  constructor({ cloudflareClient, perPage = 50 }) {
    this.cloudflareClient = cloudflareClient;
    this.perPage = perPage;
  }

  async listZones() {
    const zones = await readCloudflareList({ client: this.cloudflareClient, path: "zones", perPage: this.perPage,
      query: { direction: "asc", order: "name" }, errorMessage: "Cloudflare 域名列表读取失败" });
    return zones.map(normalizeCloudflareZone);
  }

  async listAccounts() {
    const accounts = await readCloudflareList({ client: this.cloudflareClient, path: "accounts", perPage: this.perPage,
      query: { direction: "asc" }, errorMessage: "Cloudflare 账号列表读取失败" });
    return accounts.map(normalizeAccount);
  }

  async resolveAccountId(accountId = "") {
    const requestedAccountId = String(accountId || "").trim();

    if (requestedAccountId) {
      assertCloudflareResourceId(requestedAccountId, "账号 ID");
      return requestedAccountId;
    }

    const accounts = await this.listAccounts();

    if (!accounts[0]?.id) {
      throw new HttpError(404, "当前账号下没有可用 Cloudflare Account，无法添加域名");
    }

    return accounts[0].id;
  }

  async createZone(input = {}) {
    const name = assertDomainName(input.name || input.domain);
    const accountId = await this.resolveAccountId(input.accountId || input.account_id);
    const type = String(input.type || "full").trim().toLowerCase();

    if (!["full", "partial"].includes(type)) {
      throw new HttpError(400, "域名接入类型只能是 full 或 partial");
    }

    const payload = await this.cloudflareClient.post("zones", {
      account: { id: accountId },
      jump_start: normalizeBoolean(input.jumpStart ?? input.jump_start),
      name,
      type,
    });

    return normalizeCloudflareZone(payload.result);
  }
}
