import { readCloudflareList } from "./cloudflare-list-reader.js";
import { HttpError } from "../../lib/http-error.js";
import { assertCloudflareId, assertCloudflareResourceId } from "./cloudflare-id.js";

const workerNamePattern = /^[a-z0-9-]+$/;
const bindingNamePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const maxWorkerScriptBytes = 1024 * 1024;
const preferredRouteComment = "Worker 优选域名";

export const defaultWorkerScript = `addEventListener('fetch', event => {
  event.respondWith(new Response('Hello World!'));
});`;

function assertWorkerName(value) {
  const workerName = String(value || "").trim();

  if (!workerName || workerName.length > 63 || !workerNamePattern.test(workerName)) {
    throw new HttpError(400, "Worker 名称只能包含小写字母、数字和连字符，长度不能超过 63");
  }

  if (workerName.startsWith("-") || workerName.endsWith("-")) {
    throw new HttpError(400, "Worker 名称不能以连字符开头或结尾");
  }

  return workerName;
}

function assertScriptContent(value) {
  const script = String(value || "").trimEnd();
  const scriptBytes = Buffer.byteLength(script, "utf8");

  if (!script) {
    throw new HttpError(400, "Worker 脚本代码不能为空");
  }

  if (scriptBytes > maxWorkerScriptBytes) {
    throw new HttpError(413, "Worker 脚本代码不能超过 1MB");
  }

  return script;
}

function normalizeAccount(account = {}) {
  return {
    id: account.id || "",
    name: account.name || account.id || "Cloudflare Account",
    type: account.type || "",
  };
}

function normalizeWorker(worker = {}) {
  return {
    id: worker.id || worker.name || "",
    name: worker.id || worker.name || "",
    etag: worker.etag || "",
    handlers: Array.isArray(worker.handlers) ? worker.handlers : [],
    compatibilityDate: worker.compatibility_date || "",
    compatibilityFlags: Array.isArray(worker.compatibility_flags)
      ? worker.compatibility_flags
      : [],
    createdOn: worker.created_on || "",
    modifiedOn: worker.modified_on || "",
    usageModel: worker.usage_model || "",
    logpush: Boolean(worker.logpush),
  };
}

function normalizeRoute(route = {}) {
  return {
    id: route.id || "",
    pattern: route.pattern || "",
    script: route.script || "",
  };
}

function normalizeDomain(domain = {}) {
  return {
    id: domain.id || "",
    certId: domain.cert_id || "",
    environment: domain.environment || "production",
    hostname: domain.hostname || "",
    service: domain.service || "",
    zoneId: domain.zone_id || "",
    zoneName: domain.zone_name || "",
  };
}

function normalizeSubdomainStatus(status = {}) {
  return {
    enabled: Boolean(status.enabled),
    previewsEnabled: Boolean(status.previews_enabled),
  };
}

function normalizeSettings(settings = {}) {
  const bindings = Array.isArray(settings.bindings) ? settings.bindings : [];

  return {
    bindings,
    usageModel: settings.usage_model || "",
    compatibilityDate: settings.compatibility_date || "",
    compatibilityFlags: Array.isArray(settings.compatibility_flags)
      ? settings.compatibility_flags
      : [],
  };
}

function normalizeSecret(secret = {}) {
  return {
    name: secret.name || "",
    type: secret.type || "secret_text",
  };
}

function normalizeCronSchedule(schedule = {}) {
  return {
    cron: schedule.cron || "",
    createdOn: schedule.created_on || "",
    modifiedOn: schedule.modified_on || "",
  };
}

function normalizeDeployment(deployment = {}) {
  return {
    id: deployment.id || "",
    source: deployment.source || "",
    strategy: deployment.strategy || "",
    createdOn: deployment.created_on || "",
    annotations: deployment.annotations || {},
    authorEmail: deployment.author_email || "",
    versionId: deployment.versions?.[0]?.version_id || deployment.version_id || "",
  };
}

function normalizeQueue(queue = {}) {
  return {
    id: queue.queue_id || queue.id || "",
    name: queue.queue_name || queue.name || "",
    createdOn: queue.created_on || "",
    modifiedOn: queue.modified_on || "",
  };
}

function assertBindingName(value) {
  const name = String(value || "").trim().toUpperCase();

  if (!bindingNamePattern.test(name)) {
    throw new HttpError(400, "绑定名称只能包含大写字母、数字和下划线，且必须以字母开头");
  }

  return name;
}

function normalizeBinding(input = {}) {
  const type = String(input.type || "").trim();
  const name = assertBindingName(input.name);
  const binding = { type, name };

  if (type === "plain_text") {
    const text = String(input.text ?? input.value ?? "");

    if (text.length > 4096) {
      throw new HttpError(400, "环境变量值不能超过 4096 个字符");
    }

    binding.text = text;
    return binding;
  }

  if (type === "secret_text") {
    const text = String(input.text ?? input.value ?? "");

    if (!text) {
      throw new HttpError(400, "Secret 值不能为空");
    }

    binding.text = text;
    return binding;
  }

  if (type === "kv_namespace") {
    assertCloudflareResourceId(input.namespaceId || input.namespace_id, "KV 命名空间 ID");
    binding.namespace_id = input.namespaceId || input.namespace_id;
    return binding;
  }

  if (type === "d1") {
    assertCloudflareResourceId(input.databaseId || input.id, "D1 数据库 ID");
    binding.id = input.databaseId || input.id;
    return binding;
  }

  if (type === "r2_bucket") {
    const bucketName = String(input.bucketName || input.bucket_name || "").trim();

    if (!bucketName) {
      throw new HttpError(400, "R2 存储桶名称不能为空");
    }

    binding.bucket_name = bucketName;
    return binding;
  }

  if (type === "queue") {
    const queueName = String(input.queueName || input.queue_name || "").trim();

    if (!queueName) {
      throw new HttpError(400, "Queue 名称不能为空");
    }

    binding.queue_name = queueName;
    return binding;
  }

  if (type === "service") {
    const service = String(input.service || "").trim();

    if (!service) {
      throw new HttpError(400, "Service Binding 目标 Worker 不能为空");
    }

    binding.service = service;
    binding.environment = String(input.environment || "production").trim() || "production";
    return binding;
  }

  throw new HttpError(400, "绑定类型无效");
}

function normalizeSettingsInput(input = {}, currentSettings = {}) {
  const body = {};

  if (input.compatibilityDate !== undefined) {
    const compatibilityDate = String(input.compatibilityDate || "").trim();

    if (compatibilityDate && !/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)) {
      throw new HttpError(400, "兼容日期格式应为 YYYY-MM-DD");
    }

    body.compatibility_date = compatibilityDate;
  }

  if (input.compatibilityFlags !== undefined) {
    const flags = Array.isArray(input.compatibilityFlags)
      ? input.compatibilityFlags
      : String(input.compatibilityFlags || "").split(/[\s,，]+/);
    body.compatibility_flags = flags
      .map((flag) => String(flag || "").trim())
      .filter(Boolean);
  }

  if (input.usageModel !== undefined) {
    const usageModel = String(input.usageModel || "").trim();

    if (usageModel) {
      body.usage_model = usageModel;
    }
  }

  if (input.bindings !== undefined) {
    if (!Array.isArray(input.bindings)) {
      throw new HttpError(400, "绑定配置必须是数组");
    }

    body.bindings = input.bindings.map(normalizeBinding);
  } else if (Array.isArray(currentSettings.bindings)) {
    body.bindings = currentSettings.bindings;
  }

  if (Object.keys(body).length === 0) {
    throw new HttpError(400, "没有可保存的 Worker 设置");
  }

  return body;
}

function normalizeCronInput(input = {}) {
  const schedules = (Array.isArray(input.schedules) ? input.schedules : [input])
    .map((item) => String(item.cron || item || "").trim())
    .filter(Boolean);

  if (schedules.length > 10) {
    throw new HttpError(400, "Cron Triggers 最多配置 10 条");
  }

  return {
    schedules: schedules.map((cron) => {
      if (cron.length > 100) {
        throw new HttpError(400, "Cron 表达式过长");
      }

      return { cron };
    }),
  };
}

function hasModuleSyntax(script) {
  return /\bexport\s+default\b/.test(script);
}

function currentCompatibilityDate() {
  return new Date().toISOString().slice(0, 10);
}

function buildWorkerUploadForm(script, compatibilityDate) {
  const formData = new FormData();
  const isModule = hasModuleSyntax(script);
  const scriptPartName = isModule ? "worker.js" : "script";
  const metadata = isModule
    ? {
        main_module: scriptPartName,
        compatibility_date: compatibilityDate || currentCompatibilityDate(),
      }
    : { body_part: scriptPartName };

  formData.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    "metadata.json"
  );
  formData.append(
    scriptPartName,
    new Blob([script], { type: "application/javascript" }),
    scriptPartName
  );

  return formData;
}

function normalizeZoneScopedHostname(value, zoneName, { allowPath = false } = {}) {
  const normalizedZoneName = String(zoneName || "").trim().toLowerCase();
  let input = String(value || "").trim();

  if (!normalizedZoneName) {
    throw new HttpError(400, "缺少域名区域名称");
  }

  input = input.replace(/^https?:\/\//i, "").split(/[?#]/)[0].replace(/^\/+/, "");

  if (!input) {
    throw new HttpError(400, allowPath ? "路由模式不能为空" : "自定义域不能为空");
  }

  let host = input;
  let path = "";
  const slashIndex = input.indexOf("/");

  if (slashIndex >= 0) {
    host = input.slice(0, slashIndex);
    path = input.slice(slashIndex);
  }

  host = host.trim().replace(/\.$/, "").toLowerCase();

  if (!host.includes(".")) {
    host = `${host}.${normalizedZoneName}`;
  }

  const hostForZoneCheck = host.startsWith("*.") ? host.slice(2) : host;

  if (hostForZoneCheck !== normalizedZoneName && !hostForZoneCheck.endsWith(`.${normalizedZoneName}`)) {
    throw new HttpError(400, `域名必须属于所选区域 ${normalizedZoneName}`);
  }

  if (!allowPath) {
    return host;
  }

  if (!path) {
    path = "/*";
  } else if (!path.startsWith("/")) {
    path = `/${path}`;
  } else if (path === "/") {
    path = "/*";
  }

  return `${host}${path}`;
}

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

function splitRoutePattern(pattern) {
  const slashIndex = pattern.indexOf("/");

  if (slashIndex < 0) {
    return { hostname: pattern, path: "/*" };
  }

  return {
    hostname: pattern.slice(0, slashIndex),
    path: pattern.slice(slashIndex),
  };
}

export class WorkersService {
  constructor({ cloudflareClient, dnsRecordsService, perPage = 50 }) {
    this.cloudflareClient = cloudflareClient;
    this.dnsRecordsService = dnsRecordsService;
    this.perPage = perPage;
  }

  async listAccounts() {
    const accounts = await readCloudflareList({ client: this.cloudflareClient, path: "accounts", perPage: this.perPage,
      query: { direction: "asc" }, errorMessage: "Cloudflare 账号列表读取失败" });
    return accounts.map(normalizeAccount);
  }

  async resolveAccountId(accountId = "") {
    const requestedAccountId = String(accountId || "").trim();
    const accounts = await this.listAccounts();

    if (requestedAccountId) {
      assertCloudflareId(requestedAccountId, "账号 ID");

      if (!accounts.some((account) => account.id === requestedAccountId)) {
        throw new HttpError(404, "当前凭据无权访问该 Cloudflare 账号");
      }

      return { accountId: requestedAccountId, accounts };
    }

    if (!accounts[0]?.id) {
      throw new HttpError(404, "当前账号下没有可用 Cloudflare Account");
    }

    return { accountId: accounts[0].id, accounts };
  }

  async listWorkers(accountId = "") {
    const warnings = [];
    const resolved = await this.resolveAccountId(accountId);
    const payload = await this.cloudflareClient.get(
      `accounts/${resolved.accountId}/workers/scripts`
    );

    if (!Array.isArray(payload.result)) {
      throw new HttpError(502, "Cloudflare Workers 列表返回格式异常，请稍后重试。");
    }

    const domains = await this.listDomains(resolved.accountId).catch((error) => {
      warnings.push(error.message);
      return [];
    });

    return {
      accounts: resolved.accounts,
      accountId: resolved.accountId,
      workers: payload.result.map(normalizeWorker),
      domains,
      warnings,
    };
  }

  async getWorker(scriptName, accountId = "") {
    const workerName = assertWorkerName(scriptName);
    const warnings = [];
    const resolved = await this.resolveAccountId(accountId);
    const [script, subdomain, settings, domains, schedules, deployments, secrets, queues] = await Promise.all([
      this.cloudflareClient.getText(
        `accounts/${resolved.accountId}/workers/scripts/${workerName}`
      ),
      this.getSubdomainStatus(resolved.accountId, workerName).catch((error) => {
        warnings.push(error.message);
        return null;
      }),
      this.getSettings(resolved.accountId, workerName).catch((error) => {
        warnings.push(error.message);
        return null;
      }),
      this.listDomains(resolved.accountId, { service: workerName }).catch((error) => {
        warnings.push(error.message);
        return [];
      }),
      this.listSchedules(resolved.accountId, workerName).catch((error) => {
        warnings.push(error.message);
        return [];
      }),
      this.listDeployments(resolved.accountId, workerName).catch((error) => {
        warnings.push(error.message);
        return [];
      }),
      this.listSecrets(resolved.accountId, workerName).catch((error) => {
        warnings.push(error.message);
        return [];
      }),
      this.listQueues(resolved.accountId).catch((error) => {
        warnings.push(error.message);
        return [];
      }),
    ]);

    return {
      accountId: resolved.accountId,
      accounts: resolved.accounts,
      worker: { id: workerName, name: workerName },
      script,
      subdomain,
      settings,
      domains,
      schedules,
      deployments,
      secrets,
      queues,
      warnings,
    };
  }

  async uploadWorker(accountId, scriptName, input = {}) {
    const resolved = await this.resolveAccountId(accountId);
    const workerName = assertWorkerName(scriptName);
    const script = assertScriptContent(input.script ?? defaultWorkerScript);
    const formData = buildWorkerUploadForm(script, input.compatibilityDate);
    const payload = await this.cloudflareClient.putMultipart(
      `accounts/${resolved.accountId}/workers/scripts/${workerName}`,
      formData
    );

    return {
      accountId: resolved.accountId,
      worker: normalizeWorker(payload.result || { id: workerName }),
    };
  }

  async deleteWorker(accountId, scriptName) {
    const resolved = await this.resolveAccountId(accountId);
    const workerName = assertWorkerName(scriptName);

    await this.cloudflareClient.deleteAny(
      `accounts/${resolved.accountId}/workers/scripts/${workerName}`
    );

    return { accountId: resolved.accountId, id: workerName };
  }

  async getSettings(accountId, scriptName) {
    assertCloudflareId(accountId, "账号 ID");
    const workerName = assertWorkerName(scriptName);
    const payload = await this.cloudflareClient.get(
      `accounts/${accountId}/workers/scripts/${workerName}/settings`
    );

    return normalizeSettings(payload.result || {});
  }

  async updateSettings(accountId, scriptName, input = {}) {
    const resolved = await this.resolveAccountId(accountId);
    const workerName = assertWorkerName(scriptName);
    const currentSettings = await this.getSettings(resolved.accountId, workerName).catch(() => ({}));
    const payload = await this.cloudflareClient.patch(
      `accounts/${resolved.accountId}/workers/scripts/${workerName}/settings`,
      normalizeSettingsInput(input, currentSettings)
    );

    return {
      accountId: resolved.accountId,
      settings: normalizeSettings(payload.result || {}),
    };
  }

  async listSecrets(accountId, scriptName) {
    assertCloudflareId(accountId, "账号 ID");
    const workerName = assertWorkerName(scriptName);
    const payload = await this.cloudflareClient.get(
      `accounts/${accountId}/workers/scripts/${workerName}/secrets`
    );

    if (!Array.isArray(payload.result)) {
      throw new HttpError(502, "Cloudflare Worker Secrets 返回格式异常，请稍后重试。");
    }

    return payload.result.map(normalizeSecret);
  }

  async putSecret(accountId, scriptName, input = {}) {
    const resolved = await this.resolveAccountId(accountId);
    const workerName = assertWorkerName(scriptName);
    const name = assertBindingName(input.name);
    const text = String(input.text || input.value || "");

    if (!text) {
      throw new HttpError(400, "Secret 值不能为空");
    }

    const payload = await this.cloudflareClient.put(
      `accounts/${resolved.accountId}/workers/scripts/${workerName}/secrets`,
      { name, text, type: "secret_text" }
    );

    return normalizeSecret(payload.result || { name });
  }

  async deleteSecret(accountId, scriptName, secretName) {
    const resolved = await this.resolveAccountId(accountId);
    const workerName = assertWorkerName(scriptName);
    const name = assertBindingName(secretName);

    await this.cloudflareClient.delete(
      `accounts/${resolved.accountId}/workers/scripts/${workerName}/secrets/${name}`
    );

    return { name };
  }

  async listSchedules(accountId, scriptName) {
    assertCloudflareId(accountId, "账号 ID");
    const workerName = assertWorkerName(scriptName);
    const payload = await this.cloudflareClient.get(
      `accounts/${accountId}/workers/scripts/${workerName}/schedules`
    );
    const schedules = Array.isArray(payload.result)
      ? payload.result
      : Array.isArray(payload.result?.schedules)
        ? payload.result.schedules
        : [];

    return schedules.map(normalizeCronSchedule);
  }

  async updateSchedules(accountId, scriptName, input = {}) {
    const resolved = await this.resolveAccountId(accountId);
    const workerName = assertWorkerName(scriptName);
    const payload = await this.cloudflareClient.put(
      `accounts/${resolved.accountId}/workers/scripts/${workerName}/schedules`,
      normalizeCronInput(input)
    );
    const schedules = Array.isArray(payload.result)
      ? payload.result
      : Array.isArray(payload.result?.schedules)
        ? payload.result.schedules
        : normalizeCronInput(input).schedules;

    return {
      accountId: resolved.accountId,
      schedules: schedules.map(normalizeCronSchedule),
    };
  }

  async listDeployments(accountId, scriptName) {
    assertCloudflareId(accountId, "账号 ID");
    const workerName = assertWorkerName(scriptName);
    const payload = await this.cloudflareClient.get(
      `accounts/${accountId}/workers/scripts/${workerName}/deployments`
    );
    const deployments = Array.isArray(payload.result)
      ? payload.result
      : Array.isArray(payload.result?.deployments)
        ? payload.result.deployments
        : [];

    return deployments.map(normalizeDeployment);
  }

  async createTail(accountId, scriptName) {
    const resolved = await this.resolveAccountId(accountId);
    const workerName = assertWorkerName(scriptName);
    const payload = await this.cloudflareClient.post(
      `accounts/${resolved.accountId}/workers/scripts/${workerName}/tails`,
      {}
    );

    return {
      accountId: resolved.accountId,
      tail: payload.result || {},
      note: "Cloudflare Tail 会话用于实时日志流，请使用返回的 url 或 id 在前端建立日志查看连接。",
    };
  }

  async listQueues(accountId = "") {
    const resolved = await this.resolveAccountId(accountId);
    const payload = await this.cloudflareClient.get(`accounts/${resolved.accountId}/queues`);
    const queues = Array.isArray(payload.result)
      ? payload.result
      : Array.isArray(payload.result?.queues)
        ? payload.result.queues
        : [];

    return queues.map(normalizeQueue);
  }

  async getSubdomainStatus(accountId, scriptName) {
    assertCloudflareId(accountId, "账号 ID");
    const workerName = assertWorkerName(scriptName);
    const payload = await this.cloudflareClient.get(
      `accounts/${accountId}/workers/scripts/${workerName}/subdomain`
    );

    return normalizeSubdomainStatus(payload.result || {});
  }

  async updateSubdomain(accountId, scriptName, input = {}) {
    const resolved = await this.resolveAccountId(accountId);
    const workerName = assertWorkerName(scriptName);
    const enabled = Boolean(input.enabled);
    const body = {
      enabled,
      previews_enabled:
        input.previewsEnabled === undefined ? enabled : Boolean(input.previewsEnabled),
    };
    const payload = await this.cloudflareClient.post(
      `accounts/${resolved.accountId}/workers/scripts/${workerName}/subdomain`,
      body
    );

    return {
      accountId: resolved.accountId,
      subdomain: normalizeSubdomainStatus(payload.result || body),
    };
  }

  async listRoutes(zoneId, scriptName = "") {
    assertCloudflareId(zoneId, "区域 ID");
    const workerName = scriptName ? assertWorkerName(scriptName) : "";
    const payload = await this.cloudflareClient.get(`zones/${zoneId}/workers/routes`);

    if (!Array.isArray(payload.result)) {
      throw new HttpError(502, "Cloudflare Worker 路由返回格式异常，请稍后重试。");
    }

    return payload.result
      .map(normalizeRoute)
      .filter((route) => !workerName || route.script === workerName)
      .sort((left, right) => left.pattern.localeCompare(right.pattern));
  }

  async getZoneName(zoneId, fallbackZoneName = "") {
    const zoneName = String(fallbackZoneName || "").trim().toLowerCase();

    if (zoneName) {
      return zoneName;
    }

    const payload = await this.cloudflareClient.get(`zones/${zoneId}`);
    const fetchedZoneName = String(payload.result?.name || "").trim().toLowerCase();

    if (!fetchedZoneName) {
      throw new HttpError(502, "Cloudflare 区域返回格式异常，请稍后重试。");
    }

    return fetchedZoneName;
  }

  async createRoute(zoneId, input = {}) {
    assertCloudflareId(zoneId, "区域 ID");
    const workerName = assertWorkerName(input.scriptName);
    const zoneName = await this.getZoneName(zoneId, input.zoneName);
    const pattern = normalizeZoneScopedHostname(input.pattern, zoneName, {
      allowPath: true,
    });
    const payload = await this.cloudflareClient.post(`zones/${zoneId}/workers/routes`, {
      pattern,
      script: workerName,
    });

    return normalizeRoute(payload.result || {});
  }

  async createPreferredRoute(zoneId, input = {}) {
    assertCloudflareId(zoneId, "区域 ID");

    if (!this.dnsRecordsService) {
      throw new HttpError(500, "DNS 记录服务未初始化，无法添加 Worker 优选");
    }

    const workerName = assertWorkerName(input.scriptName);
    const zoneName = await this.getZoneName(zoneId, input.zoneName);
    const pattern = normalizeZoneScopedHostname(input.pattern || input.accessHostname, zoneName, {
      allowPath: true,
    });
    const { hostname: accessHostname, path } = splitRoutePattern(pattern);
    const preferredHostname = normalizeHostname(input.preferredHostname, "优选域名");

    if (path !== "/*") {
      throw new HttpError(400, "Worker 优选路由模式必须是访问域名 + /*");
    }

    const existingRoute = (await this.listRoutes(zoneId)).find(
      (route) => route.pattern === pattern
    );

    if (existingRoute && existingRoute.script !== workerName) {
      throw new HttpError(
        409,
        `${pattern} 已绑定到 Worker ${existingRoute.script || "unknown"}，请先删除原路由`
      );
    }

    const route =
      existingRoute ||
      (await this.createRoute(zoneId, {
        pattern,
        scriptName: workerName,
        zoneName,
      }));
    let dnsRecord;

    try {
      dnsRecord = await this.dnsRecordsService.upsertCnameRecord(zoneId, {
        name: accessHostname,
        content: preferredHostname,
        ttl: 1,
        proxied: false,
        comment: preferredRouteComment,
      });
    } catch (error) {
      if (!existingRoute && route?.id) {
        await this.deleteRoute(zoneId, route.id).catch(() => null);
      }

      throw error;
    }

    return {
      accessHostname,
      dnsRecord,
      preferredHostname,
      route,
      routePattern: pattern,
      zoneId,
      zoneName,
    };
  }

  async deleteRoute(zoneId, routeId) {
    assertCloudflareId(zoneId, "区域 ID");
    assertCloudflareResourceId(routeId, "Worker 路由 ID");

    await this.cloudflareClient.delete(`zones/${zoneId}/workers/routes/${routeId}`);

    return { id: routeId };
  }

  async listDomains(accountId, filters = {}) {
    assertCloudflareId(accountId, "账号 ID");
    const payload = await this.cloudflareClient.get(
      `accounts/${accountId}/workers/domains`,
      filters
    );

    if (!Array.isArray(payload.result)) {
      throw new HttpError(502, "Cloudflare Worker 自定义域返回格式异常，请稍后重试。");
    }

    return payload.result.map(normalizeDomain).sort((left, right) => {
      return left.hostname.localeCompare(right.hostname);
    });
  }

  async createDomain(accountId, input = {}) {
    const resolved = await this.resolveAccountId(accountId);
    const workerName = assertWorkerName(input.scriptName);
    const zoneId = String(input.zoneId || "").trim();
    assertCloudflareId(zoneId, "区域 ID");
    const zoneName = await this.getZoneName(zoneId, input.zoneName);
    const hostname = normalizeZoneScopedHostname(input.hostname, zoneName);
    const payload = await this.cloudflareClient.put(
      `accounts/${resolved.accountId}/workers/domains`,
      {
        hostname,
        service: workerName,
        environment: "production",
        zone_id: zoneId,
        zone_name: zoneName,
      }
    );

    return normalizeDomain(payload.result || {});
  }

  async deleteDomain(accountId, domainId) {
    const resolved = await this.resolveAccountId(accountId);
    assertCloudflareResourceId(domainId, "Worker 自定义域 ID");

    await this.cloudflareClient.delete(
      `accounts/${resolved.accountId}/workers/domains/${domainId}`
    );

    return { accountId: resolved.accountId, id: domainId };
  }
}
