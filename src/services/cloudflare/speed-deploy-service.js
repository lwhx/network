import { normalizeDnsRecord } from "./dns-record-normalizer.js";
import { SpeedDeployTransaction } from "./speed-deploy-transaction.js";

import { HttpError } from "../../lib/http-error.js";
import { assertCloudflareId } from "./cloudflare-id.js";

const fallbackOriginIp = "6.6.6.6";
const fallbackOriginLabel = "saas";
const fallbackOriginComment = "一键加速回退源";
const accessDomainComment = "一键加速优选域名";
const defaultTlsVersion = "1.2";
const sourceRecordTypes = new Set(["A", "AAAA", "CNAME"]);

function normalizeHostname(value, label) {
  const hostname = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/g, "");

  if (!hostname) {
    throw new HttpError(400, `请输入${label}`);
  }

  if (hostname.length > 253) {
    throw new HttpError(400, `${label}长度不能超过 253 个字符`);
  }

  if (
    hostname.includes("://") ||
    hostname.includes("/") ||
    hostname.startsWith(".") ||
    !hostname.includes(".")
  ) {
    throw new HttpError(400, `${label}格式无效，请填写域名而不是 URL`);
  }

  const labels = hostname.split(".");
  const valid = labels.every(
    (item) =>
      item.length >= 1 &&
      item.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(item)
  );

  if (!valid) {
    throw new HttpError(400, `${label}格式无效`);
  }

  return hostname;
}

function normalizeCacheTtl(value) {
  const cacheTtl = Number(value ?? 0);

  if (!Number.isInteger(cacheTtl) || cacheTtl < 0) {
    throw new HttpError(400, "缓存时间必须是非负整数");
  }

  return cacheTtl;
}

function normalizeDeployInput(zoneId, input = {}) {
  assertCloudflareId(zoneId, "区域 ID");

  const zoneName = normalizeHostname(input.zoneName, "一级域名");
  const accessDomain = normalizeHostname(input.accessDomain, "访问域名");
  const targetDomain = normalizeHostname(input.targetDomain, "源站域名");
  const optimizedDomain = normalizeHostname(input.optimizedDomain, "优选域名");
  const cacheTtl = normalizeCacheTtl(input.cacheTtl);

  if (accessDomain !== zoneName && !accessDomain.endsWith(`.${zoneName}`)) {
    throw new HttpError(400, `访问域名必须属于 ${zoneName}`);
  }

  return {
    accessDomain,
    cacheTtl,
    optimizedDomain,
    targetDomain,
    zoneId,
    zoneName,
  };
}

function normalizeCustomHostname(hostname) {
  return {
    id: hostname.id,
    hostname: hostname.hostname,
    status: hostname.status || "",
    customOriginServer: hostname.custom_origin_server || "",
    sslStatus: hostname.ssl?.status || "",
    validationMethod: hostname.ssl?.method || "",
  };
}

function normalizeZoneName(zone = {}) {
  const name = String(zone.name || "").trim().toLowerCase();

  if (!name) {
    throw new HttpError(502, "Cloudflare 区域返回格式异常，请稍后重试。");
  }

  return name;
}

function speedDomainIdentity(value) {
  return normalizeHostname(value, "加速域名");
}

function customHostnameBody(config) {
  return {
    hostname: config.accessDomain,
    custom_origin_server: config.targetDomain,
    ssl: {
      method: "http",
      type: "dv",
      settings: {
        min_tls_version: defaultTlsVersion,
      },
    },
  };
}

function dnsFields(record) {
  const fields = { type: record.type, name: record.name, content: record.content,
    ttl: record.ttl, proxied: Boolean(record.proxied), comment: record.comment || "",
    tags: record.tags || [] };
  if (record.settings !== undefined) fields.settings = record.settings;
  return fields;
}

function hostnameFields(hostname) {
  return {
    hostname: hostname.hostname,
    custom_origin_server: hostname.custom_origin_server || "",
    custom_origin_sni: hostname.custom_origin_sni || "",
    custom_metadata: hostname.custom_metadata || {},
    ssl: {
      method: hostname.ssl?.method,
      type: hostname.ssl?.type,
      settings: hostname.ssl?.settings || {},
    },
  };
}

function oneRecord(records, name) {
  const matching = records.filter((record) => record.name === name);
  if (matching.length > 1) throw new HttpError(409, `${name} 存在多条解析，请先清理后再执行一键加速`);
  return matching[0] || null;
}

export class SpeedDeployService {
  constructor({ cloudflareClient, dnsRecordsService }) {
    this.cloudflareClient = cloudflareClient;
    this.dnsRecordsService = dnsRecordsService;
    this.deployingZones = new Set();
  }

  async deploy(zoneId, input) {
    const config = normalizeDeployInput(zoneId, input);
    return this.withZoneLock(zoneId, () => this.deployWithRollback(config));
  }

  async withZoneLock(zoneId, callback) {
    const account = this.cloudflareClient.getCredentials().email;
    const lockKey = `${account}:${zoneId}`;
    if (this.deployingZones.has(lockKey)) {
      throw new HttpError(409, "该账号的域名区域正在执行加速或删除操作，请稍后重试");
    }
    this.deployingZones.add(lockKey);
    try {
      return await callback();
    } finally {
      this.deployingZones.delete(lockKey);
    }
  }

  async deployWithRollback(config) {
    const zone = await this.cloudflareClient.get(`zones/${config.zoneId}`);
    if (normalizeZoneName(zone.result) !== config.zoneName) {
      throw new HttpError(409, "所选区域与域名不一致，请刷新域名列表后重试");
    }
    const fallbackOriginName = `${fallbackOriginLabel}.${config.zoneName}`;
    if (new Set([config.accessDomain, config.targetDomain, config.optimizedDomain, fallbackOriginName]).size !== 4) {
      throw new HttpError(400, "访问域名、源站域名、优选域名和回退源域名不能相同");
    }
    const [records, sslPayload, fallbackOrigin, existingHostname] = await Promise.all([
      this.listRawDnsRecords(config.zoneId),
      this.cloudflareClient.get(`zones/${config.zoneId}/settings/ssl`),
      this.readFallbackOrigin(config.zoneId),
      this.findCustomHostname(config.zoneId, config.accessDomain),
    ]);
    this.assertSourceDnsRecord(config, records);
    const accessBefore = oneRecord(records, config.accessDomain);
    const fallbackBefore = oneRecord(records, fallbackOriginName);
    if (accessBefore && accessBefore.type !== "CNAME") {
      throw new HttpError(409, `${config.accessDomain} 已存在 ${accessBefore.type} 解析，请先处理；一键加速不会覆盖其它类型`);
    }
    if (fallbackBefore && (fallbackBefore.type !== "A" || fallbackBefore.content !== fallbackOriginIp)) {
      throw new HttpError(409, `${fallbackOriginName} 已存在其它解析，请先处理后再执行一键加速`);
    }
    if (fallbackOrigin && fallbackOrigin.origin !== fallbackOriginName) {
      throw new HttpError(409, "该区域的 SaaS 回退源已用于其他配置，一键加速不会覆盖，请先在 Cloudflare 核查");
    }
    if (existingHostname && !existingHostname.custom_origin_server) {
      throw new HttpError(409, "已有自定义主机名使用默认源站，请先在 Cloudflare 配置自定义源站；一键加速不会覆盖无法安全恢复的配置");
    }
    if (!sslPayload.result?.value) throw new HttpError(502, "无法读取当前 Zone SSL 模式，请稍后重试");
    const sslSetting = { ...sslPayload.result, changed: false };
    const transaction = new SpeedDeployTransaction();
    try {
      const fallbackRecord = await transaction.apply(this.dnsOperation(config.zoneId, fallbackBefore, {
        type: "A", name: fallbackOriginName, content: fallbackOriginIp,
        ttl: 1, proxied: true, comment: fallbackOriginComment,
      }, "回退源 DNS"));
      const nextFallback = await transaction.apply(this.fallbackOperation(config.zoneId, fallbackOriginName, fallbackOrigin));
      const customHostname = await transaction.apply(this.hostnameOperation(config, existingHostname));
      // Switch incoming traffic only after the SaaS resources have been configured.
      const accessRecord = await transaction.apply(this.dnsOperation(config.zoneId, accessBefore, {
        type: "CNAME", name: config.accessDomain, content: config.optimizedDomain,
        ttl: 1, proxied: false, comment: accessDomainComment,
      }, "访问域名 DNS"));
      return {
        accessRecord: normalizeDnsRecord(accessRecord), accessDomain: config.accessDomain,
        cacheTtl: config.cacheTtl, customHostname: normalizeCustomHostname(customHostname),
        fallbackOrigin: nextFallback, fallbackRecord: normalizeDnsRecord(fallbackRecord),
        optimizedDomain: config.optimizedDomain, sslSetting,
        targetDomain: config.targetDomain, zoneId: config.zoneId, zoneName: config.zoneName,
      };
    } catch (error) {
      return transaction.fail(error);
    }
  }

  async listRawDnsRecords(zoneId) {
    const records = [];
    let page = 1;
    let totalPages = 1;
    do {
      const payload = await this.cloudflareClient.get(`zones/${zoneId}/dns_records`, { page, per_page: 100 });
      if (!Array.isArray(payload.result)) throw new HttpError(502, "Cloudflare DNS 返回格式异常");
      records.push(...payload.result);
      totalPages = Math.max(page, Number(payload.result_info?.total_pages) || page);
      page += 1;
    } while (page <= totalPages);
    return records;
  }

  async readFallbackOrigin(zoneId) {
    const payload = await this.cloudflareClient.get(`zones/${zoneId}/custom_hostnames/fallback_origin`);
    if (payload.result === null || payload.result === undefined) return null;
    if (typeof payload.result !== "object" || Array.isArray(payload.result)) {
      throw new HttpError(502, "Cloudflare SaaS 回退源返回格式异常");
    }
    if (!payload.result.origin) {
      if (Object.keys(payload.result).length === 0) return null;
      throw new HttpError(502, "Cloudflare SaaS 回退源缺少域名，无法安全执行加速");
    }
    return payload.result;
  }

  dnsOperation(zoneId, before, body, label) {
    const path = `zones/${zoneId}/dns_records`;
    return {
      label, before, expected: { tags: [], ...before, ...body }, creationBody: body, fields: dnsFields,
      creationGuard: (current) => (current.tags || []).length === 0
        && Object.values(current.settings || {}).every((value) => value === false),
      read: async () => oneRecord(await this.listRawDnsRecords(zoneId), body.name),
      write: () => before ? this.cloudflareClient.patch(`${path}/${before.id}`, body)
        : this.cloudflareClient.post(path, body),
      restore: (current) => before ? this.cloudflareClient.patch(`${path}/${before.id}`, dnsFields(before))
        : this.cloudflareClient.deleteAny(`${path}/${current.id}`),
    };
  }

  fallbackOperation(zoneId, origin, before = null) {
    const path = `zones/${zoneId}/custom_hostnames/fallback_origin`;
    return {
      label: "SaaS 回退源", before, expected: before || { origin }, creationBody: { origin },
      fields: (value) => ({ origin: value.origin }),
      read: () => this.readFallbackOrigin(zoneId),
      write: () => this.cloudflareClient.put(path, { origin }),
      restore: () => this.cloudflareClient.deleteAny(path),
    };
  }

  hostnameOperation(config, before) {
    const path = `zones/${config.zoneId}/custom_hostnames`;
    // Existing hostnames retain their certificate settings, metadata and SNI.
    const body = before ? { custom_origin_server: config.targetDomain } : customHostnameBody(config);
    return {
      label: "自定义主机名", before, expected: { ...before, ...body }, creationBody: body, fields: hostnameFields,
      creationGuard: (current) => !current.custom_origin_sni
        && Object.keys(current.custom_metadata || {}).length === 0,
      read: () => this.findCustomHostname(config.zoneId, config.accessDomain),
      write: () => before ? this.cloudflareClient.patch(`${path}/${before.id}`, body)
        : this.cloudflareClient.post(path, body),
      restore: (current) => before
        ? this.cloudflareClient.patch(`${path}/${before.id}`, { custom_origin_server: before.custom_origin_server })
        : this.cloudflareClient.deleteAny(`${path}/${current.id}`),
    };
  }

  async listManagedDomains(zoneId) {
    assertCloudflareId(zoneId, "区域 ID");
    const [zonePayload, records, customHostnames] = await Promise.all([
      this.cloudflareClient.get(`zones/${zoneId}`),
      this.dnsRecordsService.listRecords(zoneId),
      this.listCustomHostnames(zoneId).catch(() => []),
    ]);
    const zoneName = normalizeZoneName(zonePayload.result || {});
    const managedAccessRecords = records.filter(
      (record) => record.type === "CNAME" && record.comment === accessDomainComment
    );
    const managedByName = new Map();

    for (const record of managedAccessRecords) {
      managedByName.set(record.name, {
        id: record.name,
        accessDomain: record.name,
        accessRecord: record,
        fallbackOrigin: `${fallbackOriginLabel}.${zoneName}`,
        optimizedDomain: record.content,
        targetDomain: "",
        cacheTtl: "0",
        status: "dns-ready",
        customHostname: null,
        createdAt: record.createdOn || record.modifiedOn || "",
      });
    }

    for (const hostname of customHostnames) {
      const normalized = normalizeCustomHostname(hostname);
      const existing = managedByName.get(normalized.hostname) || {
        id: normalized.hostname,
        accessDomain: normalized.hostname,
        accessRecord: null,
        fallbackOrigin: `${fallbackOriginLabel}.${zoneName}`,
        optimizedDomain: "",
        cacheTtl: "0",
        createdAt: "",
      };

      managedByName.set(normalized.hostname, {
        ...existing,
        customHostname: normalized,
        targetDomain: normalized.customOriginServer,
        status: normalized.status || existing.status || "unknown",
      });
    }

    return {
      zoneId,
      zoneName,
      domains: [...managedByName.values()].sort((left, right) =>
        left.accessDomain.localeCompare(right.accessDomain)
      ),
    };
  }

  async deleteManagedDomain(zoneId, accessDomain) {
    assertCloudflareId(zoneId, "区域 ID");
    return this.withZoneLock(zoneId, () => this.deleteDomainResources(zoneId, accessDomain));
  }

  async deleteDomainResources(zoneId, accessDomain) {
    const hostname = speedDomainIdentity(accessDomain);
    const [records, customHostname] = await Promise.all([
      this.dnsRecordsService.listRecords(zoneId),
      this.findCustomHostname(zoneId, hostname).catch(() => null),
    ]);
    const deleted = [];

    for (const record of records) {
      if (record.name !== hostname || record.comment !== accessDomainComment) {
        continue;
      }

      await this.dnsRecordsService.deleteRecord(zoneId, record.id);
      deleted.push({ type: "dns", id: record.id, name: record.name });
    }

    if (customHostname?.id) {
      await this.cloudflareClient.deleteAny(
        `zones/${zoneId}/custom_hostnames/${customHostname.id}`
      );
      deleted.push({ type: "custom_hostname", id: customHostname.id, name: hostname });
    }

    if (deleted.length === 0) {
      throw new HttpError(404, "未找到由面板管理的加速域名");
    }

    return { zoneId, accessDomain: hostname, deleted };
  }

  assertSourceDnsRecord(config, records) {
    const sourceBelongsToZone =
      config.targetDomain === config.zoneName ||
      config.targetDomain.endsWith(`.${config.zoneName}`);

    if (!sourceBelongsToZone) {
      return;
    }

    const hasSourceRecord = records.some(
      (record) =>
        record.name === config.targetDomain && sourceRecordTypes.has(record.type)
    );

    if (!hasSourceRecord) {
      throw new HttpError(
        409,
        `源站域名 ${config.targetDomain} 未添加 DNS 解析，请先添加 A、AAAA 或 CNAME 记录后再执行一键加速`
      );
    }
  }

  async findCustomHostname(zoneId, hostname) {
    const payload = await this.cloudflareClient.get(`zones/${zoneId}/custom_hostnames`, {
      hostname,
      page: 1,
      per_page: 50,
    });

    if (!Array.isArray(payload.result)) {
      throw new HttpError(502, "Cloudflare API 返回自定义主机名格式异常");
    }

    return payload.result.find((item) => item.hostname === hostname) || null;
  }

  async listCustomHostnames(zoneId) {
    const hostnames = [];
    let page = 1;
    let totalPages = 1;

    do {
      const payload = await this.cloudflareClient.get(`zones/${zoneId}/custom_hostnames`, {
        page,
        per_page: 50,
      });

      if (!Array.isArray(payload.result)) {
        throw new HttpError(502, "Cloudflare API 返回自定义主机名格式异常");
      }

      hostnames.push(...payload.result);

      const pageCount = Number(payload.result_info?.total_pages);
      const totalCount = Number(payload.result_info?.total_count);
      totalPages = Number.isFinite(pageCount)
        ? Math.max(1, pageCount)
        : Number.isFinite(totalCount)
          ? Math.max(1, Math.ceil(totalCount / 50))
          : page;
      page += 1;
    } while (page <= totalPages);

    return hostnames;
  }
}

export const speedDeployConstants = {
  accessDomainComment,
  defaultTlsVersion,
  fallbackOriginComment,
  fallbackOriginIp,
  fallbackOriginLabel,
};
