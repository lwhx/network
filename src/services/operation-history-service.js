import { randomUUID } from "node:crypto";
import { HttpError } from "../lib/http-error.js";
import { OperationHistoryStore } from "./operation-history-store.js";

const mutatingMethods = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const defaultMaxEntries = 3000;
const maxListEntries = 300;
const statuses = ["success", "partial", "failed", "unknown"];
const statusMessages = { success: "", partial: "部分操作未完成", failed: "操作失败", unknown: "操作结果未知" };
const dnsTypeError = "DNS 记录类型暂不支持";

const moduleMatchers = [
  [/^\/api\/speed-tasks/i, "加速任务恢复"],
  [/^\/api\/zones\/[^/]+\/dns-records/i, "DNS 记录"],
  [/^\/api\/zones\/[^/]+\/ssl-settings/i, "SSL\/TLS"],
  [/^\/api\/zones\/[^/]+\/cache-settings|^\/api\/zones\/[^/]+\/purge-cache/i, "缓存管理"],
  [/^\/api\/zones\/[^/]+\/firewall-rules|^\/api\/zones\/[^/]+\/firewall-rulesets/i, "防火墙"],
  [/^\/api\/zones\/[^/]+\/page-rules/i, "页面规则"],
  [/^\/api\/zones\/[^/]+\/certificates|^\/api\/zones\/[^/]+\/origin-certificates/i, "证书管理"],
  [/^\/api\/zones\/[^/]+\/speed-deploy/i, "一键加速"],
  [/^\/api\/zones\/[^/]+\/automation/i, "自动优化"],
  [/^\/api\/workers/i, "Workers"],
  [/^\/api\/developer-resources\/pages/i, "Pages"],
  [/^\/api\/developer-resources\/d1/i, "D1 数据库"],
  [/^\/api\/developer-resources\/r2/i, "R2 存储桶"],
  [/^\/api\/developer-resources\/kv/i, "Workers KV"],
  [/^\/api\/developer-resources\/tunnels/i, "Cloudflare Tunnels"],
];

const actionLabels = {
  POST: "创建",
  PATCH: "更新",
  PUT: "保存",
  DELETE: "删除",
};

function normalizeLimit(value, fallback = 80) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const limit = Number(value);

  if (!Number.isInteger(limit)) {
    return fallback;
  }

  return Math.min(Math.max(limit, 1), maxListEntries);
}

function text(value, maxLength = 300) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength) : "";
}

function normalizeMaxEntries(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0
    ? Math.min(Number(value), defaultMaxEntries) : defaultMaxEntries;
}

function normalizeDate(value, field) {
  if (value === null || value === undefined || value === "") return "";
  const input = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(input);
  const invalid = () => { throw new HttpError(400, `操作历史 ${field} 时间格式无效`); };
  if (!match) invalid();
  const [, year, month, day, hour = "00", minute = "00", second = "00", fraction = "", timezone = "Z"] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}` || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) invalid();
  const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, "0") || "000"}${timezone}`);
  if (!Number.isFinite(parsed)) invalid();
  return new Date(parsed).toISOString();
}

function normalizeSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const summary = {};
  for (const key of ["total", "succeeded", "failed", "unknown", "skipped"]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) summary[key] = value[key];
  }
  return Object.keys(summary).length ? summary : undefined;
}

function filterOptions(entries, accountId) {
  const accounts = new Map();
  const zones = new Map();
  // Entries arrive newest first. Missing context must not erase an earlier known label.
  for (const entry of entries) {
    if (entry.accountId) {
      const account = accounts.get(entry.accountId);
      if (!account) accounts.set(entry.accountId, { id: entry.accountId, name: entry.accountName });
      else if (!account.name) account.name = entry.accountName;
    }
    if (entry.zoneId && (!accountId || entry.accountId === accountId)) {
      const key = JSON.stringify([entry.accountId, entry.zoneId]);
      const zone = zones.get(key);
      if (!zone) zones.set(key, { id: entry.zoneId, name: entry.zoneName, accountId: entry.accountId });
      else if (!zone.name) zone.name = entry.zoneName;
    }
  }
  const options = (values) => [...values.values()]
    .map((option) => ({ ...option, name: option.name || option.id }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  return { accounts: options(accounts), zones: options(zones) };
}

function labelModule(pathname) {
  return moduleMatchers.find(([pattern]) => pattern.test(pathname))?.[1] || "Cloudflare API";
}

function resourceFromParams(params = {}) {
  return (
    params.accessDomain ||
    params.scriptName ||
    params.resourceId ||
    params.recordId ||
    params.ruleId ||
    params.certificateId ||
    params.zoneId ||
    ""
  );
}

function compactPath(pathname) {
  return pathname.replace(/^\/api\//, "");
}

function normalizeEntry(entry = {}) {
  const method = text(entry.method, 10).toUpperCase();
  const pathname = text(entry.pathname || entry.path, 1000).split(/[?#]/, 1)[0];
  const module = text(entry.module) || labelModule(pathname);
  const resource = text(entry.resource || resourceFromParams(entry.params));
  const status = statuses.includes(entry.status) ? entry.status : "success";
  const createdAt = normalizeDate(entry.createdAt || new Date().toISOString(), "createdAt");
  const error = status === "failed" && (entry.safeError === dnsTypeError || entry.error === dnsTypeError)
    ? dnsTypeError : statusMessages[status];
  const duration = Number(entry.durationMs ?? entry.duration);
  const code = Number(entry.statusCode);
  const summary = normalizeSummary(entry.summary);

  return {
    id: text(entry.id) || randomUUID(),
    action: text(entry.action) || actionLabels[method] || "操作",
    durationMs: Number.isFinite(duration) ? Math.max(0, duration) : 0,
    error,
    method,
    module,
    path: compactPath(pathname),
    resource,
    status,
    statusCode: Number.isInteger(code) && code >= 100 && code <= 599 ? code : (status === "failed" ? 500 : 200),
    createdAt,
    accountId: text(entry.accountId),
    accountName: text(entry.accountName),
    zoneId: text(entry.zoneId),
    zoneName: text(entry.zoneName),
    ...(summary ? { summary } : {}),
  };
}

export class OperationHistoryService {
  constructor({ maxEntries = defaultMaxEntries, store } = {}) {
    this.maxEntries = normalizeMaxEntries(maxEntries);
    this.store = store ? new OperationHistoryStore({ database: store.database }) : null;
    this.store?.prune(this.maxEntries);
    // In-memory mode is retained for isolated legacy test fixtures.
    this.entries = [];
  }

  shouldRecord(method, pathname) {
    return (
      mutatingMethods.has(String(method || "").toUpperCase()) &&
      pathname.startsWith("/api/") &&
      !pathname.startsWith("/api/operation-history") &&
      !pathname.startsWith("/api/session/") &&
      !pathname.startsWith("/api/setup/")
    );
  }

  record(entry) {
    const normalized = normalizeEntry(entry);
    if (this.store) {
      this.store.record(normalized, this.maxEntries);
      return normalized;
    }
    this.entries.unshift(normalized);

    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }

    return normalized;
  }

  list({ accountId = "", zoneId = "", module = "", status = "", from = "", to = "", limit = 80, offset = 0 } = {}) {
    const normalizedAccount = text(accountId);
    const normalizedZone = text(zoneId);
    const normalizedModule = String(module || "").trim();
    const normalizedStatus = String(status || "").trim();
    const normalizedLimit = normalizeLimit(limit);
    const normalizedOffset = Number.isSafeInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
    const normalizedFrom = normalizeDate(from, "from");
    const normalizedTo = normalizeDate(to, "to");
    if (normalizedFrom && normalizedTo && normalizedFrom > normalizedTo) {
      throw new HttpError(400, "操作历史起始时间不能晚于结束时间");
    }
    const all = this.store ? this.store.all() : this.entries;
    let entries = all;
    if (normalizedAccount) entries = entries.filter((entry) => entry.accountId === normalizedAccount);
    if (normalizedZone) entries = entries.filter((entry) => entry.zoneId === normalizedZone);
    if (normalizedFrom) entries = entries.filter((entry) => entry.createdAt >= normalizedFrom);
    if (normalizedTo) entries = entries.filter((entry) => entry.createdAt <= normalizedTo);

    if (normalizedModule) {
      entries = entries.filter((entry) => entry.module === normalizedModule);
    }

    if (normalizedStatus) {
      entries = entries.filter((entry) => entry.status === normalizedStatus);
    }

    return {
      entries: entries.slice(normalizedOffset, normalizedOffset + normalizedLimit),
      filters: {
        ...filterOptions(all, normalizedAccount),
        modules: [...new Set(all.map((entry) => entry.module))].sort((left, right) =>
          left.localeCompare(right)
        ),
        statuses: [...statuses],
      },
      total: all.length,
      filteredTotal: entries.length,
    };
  }

  clear() {
    if (this.store) return this.store.clear();
    const deleted = this.entries.length;
    this.entries = [];

    return { deleted };
  }
}
