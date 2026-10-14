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

// Only operation descriptors enter the encrypted journal. Credentials and
// authentication fields never cross this boundary, including metadata keys.
function safeSnapshot(value) {
  if (Array.isArray(value)) return value.map(safeSnapshot);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:api.?key|password|passwd|totp|secret|token|authorization|credential)/i.test(key))
    .map(([key, child]) => [key, safeSnapshot(child)]));
}
function operationDescriptor(operation) {
  const project = value => value ? safeSnapshot({ ...(value.id ? { id: value.id } : {}), ...operation.fields(value) }) : null;
  return { type: operation.type, zoneId: operation.zoneId, label: operation.label,
    before: project(operation.before), expected: project(operation.expected),
    creationBody: safeSnapshot(operation.creationBody), confirmed: Boolean(operation.confirmed), status: operation.status };
}

function oneRecord(records, name) {
  const matching = records.filter((record) => record.name === name);
  if (matching.length > 1) throw new HttpError(409, `${name} 存在多条解析，请先清理后再执行一键加速`);
  return matching[0] || null;
}

export class SpeedDeployService {
  constructor({ cloudflareClient, dnsRecordsService, speedTaskStore = null }) {
    this.cloudflareClient = cloudflareClient;
    this.dnsRecordsService = dnsRecordsService;
    this.deployingZones = new Set();
    this.speedTaskStore = speedTaskStore;
  }

  async deploy(zoneId, input) {
    const config = normalizeDeployInput(zoneId, input);
    return this.withZoneLock(zoneId, async () => {
      if (!this.speedTaskStore) return this.deployWithRollback(config);
      const accountId = this.taskAccountId();
      const taskId = this.speedTaskStore.begin(accountId, config);
      const snapshot = { steps: [], audit: [] };
      const persist = (operations) => {
        snapshot.steps = operations.map(operationDescriptor);
        this.speedTaskStore.save(taskId, accountId, snapshot);
      };
      try {
        const result = await this.deployWithRollback(config, persist);
        this.speedTaskStore.save(taskId, accountId, snapshot, { status: "completed" });
        return { ...result, taskId };
      } catch (error) {
        const status = error.rollback?.status === "complete" || (!error.rollback && !snapshot.steps.length) ? "rolled_back" : "manual_needed";
        snapshot.audit.push({ action: "deployment_failed", at: new Date().toISOString(), status });
        this.speedTaskStore.save(taskId, accountId, snapshot, { status, error: "加速任务失败，请检查步骤与恢复状态" });
        const safeMessage = error.localValidation ? error.message : "加速任务失败，请检查任务记录与恢复状态";
        const summary = error.rollback ? (error.rollback.status === "complete" ? "；已恢复本次操作涉及的配置" : "；恢复未完成，部分步骤需要人工核查") : "";
        const failure = new HttpError(error.statusCode || 502, safeMessage + summary);
        failure.taskId = taskId;
        failure.rollback = error.rollback;
        throw failure;
      }
    });
  }

  async withZoneLock(zoneId, callback) {
    const credentials = this.cloudflareClient.getCredentials();
    const account = this.speedTaskStore ? this.taskAccountId() : (credentials.accountId || credentials.email);
    const lockKey = `${account}:${zoneId}`;
    if (this.deployingZones.has(lockKey)) {
      throw new HttpError(409, "该账号的域名区域正在执行加速或删除操作，请稍后重试");
    }
    if (this.speedTaskStore) this.speedTaskStore.acquireScope(account, zoneId);
    this.deployingZones.add(lockKey);
    try {
      return await callback();
    } finally {
      this.deployingZones.delete(lockKey);
      if (this.speedTaskStore) this.speedTaskStore.releaseScope(account, zoneId);
    }
  }

  async deployWithRollback(config, journal = null) {
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
    const transaction = new SpeedDeployTransaction({ journal });
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

  taskAccountId() {
    const credentials = this.cloudflareClient.getCredentials();
    if (!credentials.accountId || !credentials.email || !credentials.globalApiKey) {
      throw new HttpError(412, "请先选择并保存有效的 Cloudflare 账号凭据");
    }
    return credentials.accountId;
  }

  taskStore() {
    if (!this.speedTaskStore) throw new HttpError(503, "任务记录暂不可用");
    return this.speedTaskStore;
  }

  listTasks({ zoneId } = {}) {
    if (zoneId) assertCloudflareId(zoneId, "区域 ID");
    return this.taskStore().list(this.taskAccountId(), { zoneId });
  }

  rebuildOperation(step) {
    let operation;
    if (step.type === "delete_dns" || step.type === "delete_hostname") {
      operation = { type: step.type, zoneId: step.zoneId, label: step.label, before: step.before, expected: null,
        creationBody: step.creationBody, fields: step.type === "delete_dns" ? dnsFields : hostnameFields,
        read: () => step.type === "delete_dns" ? this.listRawDnsRecords(step.zoneId).then(records => oneRecord(records, step.before.name))
          : this.findCustomHostname(step.zoneId, step.before.hostname),
        restore: () => { throw new HttpError(409, "删除任务需要人工核查，面板不会重建已删除资源"); } };
    }
    else if (step.type === "dns") operation = this.dnsOperation(step.zoneId, step.before, step.creationBody, step.label);
    else if (step.type === "fallback") operation = this.fallbackOperation(step.zoneId, step.creationBody.origin, step.before);
    else if (step.type === "hostname") operation = this.hostnameOperation({ zoneId: step.zoneId,
      accessDomain: step.expected.hostname, targetDomain: step.creationBody.custom_origin_server }, step.before);
    else throw new HttpError(409, "任务步骤无法识别，请人工核查");
    return Object.assign(operation, { expected: step.expected, confirmed: step.confirmed, status: step.status });
  }

  async inspectTask(taskId) {
    const accountId = this.taskAccountId(), store = this.taskStore();
    const { row, snapshot } = store.load(taskId, accountId);
    const transaction = new SpeedDeployTransaction({ journal: () => {} });
    const steps = [];
    for (const descriptor of snapshot.steps) {
      const operation = this.rebuildOperation(descriptor);
      let classification;
      try { classification = transaction.classify(operation, await operation.read()); }
      catch { classification = "unreadable"; }
      steps.push({ resource: descriptor.label, type: descriptor.type, status: descriptor.status, classification });
    }
    if (steps.every(step => step.classification !== "unreadable")) store.markInspected(taskId, accountId, row.revision);
    return { ...store.get(taskId, accountId), steps };
  }

  async recoverTask(taskId) {
    const accountId = this.taskAccountId(), store = this.taskStore();
    const snapshot = store.claim(taskId, accountId);
    snapshot.audit.push({ action: "rollback_requested", at: new Date().toISOString(), status: "recovering" });
    store.save(taskId, accountId, snapshot);
    try {
      const transaction = new SpeedDeployTransaction({ journal: (operations) => {
        snapshot.steps = operations.map(operationDescriptor);
        store.save(taskId, accountId, snapshot);
      } });
      transaction.operations = snapshot.steps.map(step => this.rebuildOperation(step));
      const rollback = await transaction.rollback();
      const status = rollback.status === "complete" ? "rolled_back" : "manual_needed";
      snapshot.audit.push({ action: "rollback_finished", at: new Date().toISOString(), status });
      store.save(taskId, accountId, snapshot, { status, error: rollback.status === "complete" ? "" : "部分步骤需要人工核查" });
      return { ...store.get(taskId, accountId), rollback };
    } catch {
      store.save(taskId, accountId, snapshot, { status: "manual_needed", error: "任务恢复未完成，请人工核查" });
      throw new HttpError(502, "任务恢复未完成，请重新检查任务记录");
    }
  }

  resolveManualTask(taskId) {
    const accountId = this.taskAccountId(), store = this.taskStore();
    const snapshot = store.claim(taskId, accountId, { resolving: true });
    snapshot.audit.push({ action: "manual_acknowledged", at: new Date().toISOString(), status: "manual_resolved" });
    store.save(taskId, accountId, snapshot, { status: "manual_resolved" });
    return store.get(taskId, accountId);
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
      type: "dns", zoneId, label, before, expected: { tags: [], ...before, ...body }, creationBody: body, fields: dnsFields,
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
      type: "fallback", zoneId, label: "SaaS 回退源", before, expected: before || { origin }, creationBody: { origin },
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
      type: "hostname", zoneId: config.zoneId, label: "自定义主机名", before, expected: { ...before, ...body }, creationBody: body, fields: hostnameFields,
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
      this.listRawDnsRecords(zoneId),
      this.findCustomHostname(zoneId, hostname),
    ]);
    const deleted = [];
    const targets = records.filter(record => record.name === hostname && record.comment === accessDomainComment).map(record => ({
      type: "delete_dns", before: record, fields: dnsFields, label: "删除访问域名 DNS",
      read: () => this.listRawDnsRecords(zoneId).then(items => oneRecord(items, record.name)),
      write: () => this.dnsRecordsService.deleteRecord(zoneId, record.id), result: { type: "dns", id: record.id, name: record.name },
    }));
    if (customHostname?.id) targets.push({ type: "delete_hostname", before: customHostname, fields: hostnameFields, label: "删除自定义主机名",
      read: () => this.findCustomHostname(zoneId, hostname),
      write: () => this.cloudflareClient.deleteAny(`zones/${zoneId}/custom_hostnames/${customHostname.id}`),
      result: { type: "custom_hostname", id: customHostname.id, name: hostname } });
    if (!targets.length) throw new HttpError(404, "未找到由面板管理的加速域名");
    if (!this.speedTaskStore) {
      for (const target of targets) { await target.write(); deleted.push(target.result); }
      return { zoneId, accessDomain: hostname, deleted };
    }
    const accountId = this.taskAccountId();
    const zone = await this.cloudflareClient.get(`zones/${zoneId}`);
    const taskId = this.speedTaskStore.begin(accountId, { zoneId, zoneName: normalizeZoneName(zone.result), accessDomain: hostname });
    const snapshot = { kind: "deletion", steps: [], audit: [] };
    const checker = new SpeedDeployTransaction({ journal: () => {} });
    let index = 0;
    try {
      for (const target of targets) {
        if (!checker.same(target, await target.read(), target.before)) throw new HttpError(409, "资源已被其他操作修改，请重新核查后删除");
        const step = { type: target.type, zoneId, label: target.label,
          before: safeSnapshot({ id: target.before.id, ...target.fields(target.before) }), expected: null,
          creationBody: {}, confirmed: false, status: "pending" };
        snapshot.steps.push(step);
        // This write-ahead checkpoint also fences a worker whose lease was reclaimed.
        this.speedTaskStore.save(taskId, accountId, snapshot);
        let accepted = false;
        try {
          await target.write(); accepted = true;
          if (await target.read()) {
            const error = new HttpError(502, "删除请求结果无法确认，请人工核查"); error.remoteOutcomeUnknown = true; throw error;
          }
        } catch (error) {
          if (accepted) error.remoteOutcomeUnknown = true;
          if (!error.remoteOutcomeUnknown && error.statusCode >= 400 && error.statusCode < 500) {
            step.status = "rejected"; this.speedTaskStore.save(taskId, accountId, snapshot);
          }
          throw error;
        }
        step.confirmed = true; step.status = "deleted";
        this.speedTaskStore.save(taskId, accountId, snapshot);
        deleted.push(target.result); index += 1;
      }
      this.speedTaskStore.save(taskId, accountId, snapshot, { status: "completed" });
      return { zoneId, accessDomain: hostname, deleted, taskId,
        summary: { total: targets.length, succeeded: deleted.length, failed: 0, unknown: 0, skipped: 0 } };
    } catch (error) {
      const unknown = Boolean(error.remoteOutcomeUnknown);
      const status = deleted.length || snapshot.steps.some(step => step.status === "pending") ? "manual_needed" : "rolled_back";
      snapshot.audit.push({ action: "deletion_failed", at: new Date().toISOString(), status });
      this.speedTaskStore.save(taskId, accountId, snapshot, { status, error: "删除任务未完成，请核查任务记录" });
      const failure = new HttpError(error.statusCode || 502, "删除任务未完成，请核查任务记录");
      failure.taskId = taskId;
      failure.summary = { total: targets.length, succeeded: deleted.length, failed: unknown ? 0 : 1, unknown: unknown ? 1 : 0, skipped: Math.max(0, targets.length - index - 1) };
      throw failure;
    }
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
      const error = new HttpError(
        409,
        `源站域名 ${config.targetDomain} 未添加 DNS 解析，请先添加 A、AAAA 或 CNAME 记录后再执行一键加速`
      );
      error.localValidation = true;
      throw error;
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
