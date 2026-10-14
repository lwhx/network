import { readCloudflareList } from "./cloudflare-list-reader.js";
import { randomBytes } from "node:crypto";
import { HttpError } from "../../lib/http-error.js";
import { assertD1SqlAllowed } from "../../lib/sql-safety.js";
import { assertCloudflareId, assertCloudflareResourceId } from "./cloudflare-id.js";

const resourceTypes = new Set(["pages", "d1", "r2", "kv", "tunnels"]);
const resourceNamePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/i;
const r2BucketNamePattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function assertResourceType(type) {
  const normalizedType = String(type || "").trim().toLowerCase();

  if (!resourceTypes.has(normalizedType)) {
    throw new HttpError(404, "资源模块不存在");
  }

  return normalizedType;
}

function assertResourceName(value, label, { r2 = false } = {}) {
  const name = String(value || "").trim();
  const pattern = r2 ? r2BucketNamePattern : resourceNamePattern;

  if (!pattern.test(name)) {
    throw new HttpError(
      400,
      r2
        ? `${label} 只能包含小写字母、数字和连字符，长度 3-63`
        : `${label} 只能包含字母、数字、点、下划线和连字符，长度 1-63`
    );
  }

  return r2 ? name.toLowerCase() : name;
}

function normalizeAccount(account = {}) {
  return {
    id: account.id || "",
    name: account.name || account.id || "Cloudflare Account",
    type: account.type || "",
  };
}

function listFromPayload(payload, nestedKeys = []) {
  if (Array.isArray(payload.result)) {
    return payload.result;
  }

  for (const key of nestedKeys) {
    if (Array.isArray(payload.result?.[key])) {
      return payload.result[key];
    }
  }

  return null;
}

function assertKvKey(value) {
  const key = String(value || "").trim();

  if (!key || key.length > 512) {
    throw new HttpError(400, "KV Key 不能为空，且长度不能超过 512");
  }

  return key;
}

function assertR2ObjectKey(value) {
  const key = String(value || "").trim().replace(/^\/+/, "");

  if (!key || key.length > 1024) {
    throw new HttpError(400, "R2 对象 Key 不能为空，且长度不能超过 1024");
  }

  return key;
}

function normalizePagesDeployment(deployment = {}) {
  return {
    id: deployment.id || "",
    projectName: deployment.project_name || "",
    url: deployment.url || "",
    environment: deployment.environment || "",
    branch: deployment.deployment_trigger?.metadata?.branch || deployment.production_branch || "",
    status: deployment.latest_stage?.status || deployment.stage || "",
    createdOn: deployment.created_on || "",
    modifiedOn: deployment.modified_on || "",
  };
}

function normalizePagesDomain(domain = {}) {
  return {
    id: domain.id || domain.name || "",
    name: domain.name || domain.hostname || "",
    status: domain.status || "",
    createdOn: domain.created_on || "",
  };
}

function normalizeD1QueryResult(result = {}) {
  return {
    success: result.success !== false,
    meta: result.meta || {},
    results: Array.isArray(result.results) ? result.results : [],
    duration: result.duration || result.meta?.duration || 0,
  };
}

function normalizeR2Object(object = {}) {
  return {
    key: object.key || object.name || "",
    size: object.size || 0,
    etag: object.etag || object.httpEtag || "",
    uploaded: object.uploaded || object.last_modified || "",
    storageClass: object.storage_class || "",
    checksums: object.checksums || {},
  };
}

function normalizeKvKey(key = {}) {
  return {
    name: key.name || "",
    expiration: key.expiration || null,
    metadata: key.metadata || null,
  };
}

function kvPageOptions(options = {}) {
  const prefix = options.prefix ?? "";
  const cursor = options.cursor ?? "";
  const limit = options.limit == null || options.limit === "" ? 50 : Number(options.limit);
  if (typeof prefix !== "string" || Buffer.byteLength(prefix) > 512 ||
      typeof cursor !== "string" || Buffer.byteLength(cursor) > 4096 ||
      !Number.isInteger(limit) || limit < 10 || limit > 1000) {
    throw new HttpError(400, "KV 分页参数无效：每页 10-1000 条，前缀最多 512 字节。");
  }
  return { prefix, cursor, limit };
}

function normalizePagesProject(project = {}) {
  const deployment = project.latest_deployment || project.canonical_deployment || {};

  return {
    id: project.name || project.id || "",
    name: project.name || project.id || "",
    badge: project.production_branch || "main",
    createdOn: project.created_on || "",
    modifiedOn: deployment.modified_on || deployment.created_on || "",
    status: deployment.latest_stage?.status || deployment.stage || project.status || "",
    description: project.subdomain || `${project.name || "project"}.pages.dev`,
    meta: [
      ["生产分支", project.production_branch || "-"],
      ["部署", deployment.id || "-"],
      ["域名", Array.isArray(project.domains) ? project.domains.length : 0],
    ],
  };
}

function normalizeD1Database(database = {}) {
  return {
    id: database.uuid || database.id || "",
    name: database.name || database.uuid || database.id || "",
    badge: database.version || "D1",
    createdOn: database.created_at || database.created_on || "",
    modifiedOn: database.modified_at || database.modified_on || "",
    status: database.running_in_region || database.primary_location_hint || "",
    description: database.uuid || database.id || "Cloudflare D1 Database",
    meta: [
      ["UUID", database.uuid || database.id || "-"],
      ["表数量", database.num_tables ?? "-"],
      ["大小", database.file_size ? `${database.file_size} B` : "-"],
    ],
  };
}

function normalizeR2Bucket(bucket = {}) {
  return {
    id: bucket.name || "",
    name: bucket.name || "",
    badge: bucket.location || bucket.jurisdiction || "R2",
    createdOn: bucket.creation_date || bucket.created_at || "",
    modifiedOn: bucket.modified_at || "",
    status: bucket.storage_class || bucket.location || "",
    description: bucket.name ? `${bucket.name} bucket` : "Cloudflare R2 Bucket",
    meta: [
      ["位置", bucket.location || bucket.jurisdiction || "Auto"],
      ["创建时间", bucket.creation_date || bucket.created_at || "-"],
      ["对象", bucket.object_count ?? "-"],
    ],
  };
}

function normalizeKvNamespace(namespace = {}) {
  return {
    id: namespace.id || "",
    name: namespace.title || namespace.id || "",
    badge: "KV",
    createdOn: namespace.created_on || namespace.created_at || "",
    modifiedOn: namespace.modified_on || "",
    status: namespace.supports_url_encoding ? "URL Encoding" : "",
    description: namespace.id || "Workers KV Namespace",
    meta: [
      ["Namespace ID", namespace.id || "-"],
      ["标题", namespace.title || "-"],
      ["URL Encoding", namespace.supports_url_encoding ? "支持" : "默认"],
    ],
  };
}

function normalizeTunnel(tunnel = {}) {
  const activeConnections = Array.isArray(tunnel.connections)
    ? tunnel.connections.filter((connection) => !connection.is_pending_reconnect).length
    : 0;

  return {
    id: tunnel.id || "",
    name: tunnel.name || tunnel.id || "",
    badge: tunnel.config_src || "cloudflared",
    createdOn: tunnel.created_at || tunnel.created_on || "",
    modifiedOn: tunnel.conns_active_at || "",
    status: tunnel.status || (activeConnections ? "active" : "inactive"),
    description: tunnel.id || "Cloudflare Tunnel",
    meta: [
      ["Tunnel ID", tunnel.id || "-"],
      ["连接器", activeConnections],
      ["配置源", tunnel.config_src || "cloudflared"],
    ],
  };
}

const definitions = {
  pages: {
    listPath: (accountId) => `accounts/${accountId}/pages/projects`,
    createPath: (accountId) => `accounts/${accountId}/pages/projects`,
    deletePath: (accountId, projectName) =>
      `accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}`,
    perPage: 10,
    normalize: normalizePagesProject,
    listKeys: [],
    createBody(input) {
      const name = assertResourceName(input.name, "Pages 项目名称");
      return {
        name,
        production_branch: String(input.productionBranch || "main").trim() || "main",
      };
    },
    normalizeId(id) {
      return assertResourceName(id, "Pages 项目名称");
    },
    createMethod: "post",
  },
  d1: {
    listPath: (accountId) => `accounts/${accountId}/d1/database`,
    createPath: (accountId) => `accounts/${accountId}/d1/database`,
    deletePath: (accountId, databaseId) => `accounts/${accountId}/d1/database/${databaseId}`,
    normalize: normalizeD1Database,
    listKeys: ["databases"],
    createBody(input) {
      return { name: assertResourceName(input.name, "D1 数据库名称") };
    },
    normalizeId(id) {
      assertCloudflareResourceId(id, "D1 数据库 ID");
      return id;
    },
    createMethod: "post",
  },
  r2: {
    pagination: "cursor",
    listPath: (accountId) => `accounts/${accountId}/r2/buckets`,
    createPath: (accountId) => `accounts/${accountId}/r2/buckets`,
    deletePath: (accountId, bucketName) =>
      `accounts/${accountId}/r2/buckets/${assertResourceName(bucketName, "R2 存储桶名称", {
        r2: true,
      })}`,
    normalize: normalizeR2Bucket,
    listKeys: ["buckets"],
    createBody(input) {
      return {
        name: assertResourceName(input.name, "R2 存储桶名称", { r2: true }),
        jurisdiction: input.jurisdiction === "eu" || input.jurisdiction === "fedramp"
          ? input.jurisdiction
          : "default",
      };
    },
    normalizeId(id) {
      return assertResourceName(id, "R2 存储桶名称", { r2: true });
    },
    createMethod: "post",
  },
  kv: {
    listPath: (accountId) => `accounts/${accountId}/storage/kv/namespaces`,
    createPath: (accountId) => `accounts/${accountId}/storage/kv/namespaces`,
    deletePath: (accountId, namespaceId) =>
      `accounts/${accountId}/storage/kv/namespaces/${namespaceId}`,
    normalize: normalizeKvNamespace,
    listKeys: ["namespaces"],
    createBody(input) {
      return { title: assertResourceName(input.name, "KV 命名空间名称") };
    },
    normalizeId(id) {
      assertCloudflareResourceId(id, "KV 命名空间 ID");
      return id;
    },
    createMethod: "post",
  },
  tunnels: {
    listPath: (accountId) => `accounts/${accountId}/cfd_tunnel`,
    listQuery: { is_deleted: false },
    createPath: (accountId) => `accounts/${accountId}/cfd_tunnel`,
    deletePath: (accountId, tunnelId) => `accounts/${accountId}/cfd_tunnel/${tunnelId}`,
    normalize: normalizeTunnel,
    listKeys: ["tunnels"],
    createBody(input) {
      return {
        name: assertResourceName(input.name, "Tunnel 名称"),
        config_src: input.configSrc === "local" ? "local" : "cloudflare",
        tunnel_secret: input.tunnelSecret || randomBytes(32).toString("base64"),
      };
    },
    normalizeId(id) {
      assertCloudflareResourceId(id, "Tunnel ID");
      return id;
    },
    createMethod: "post",
  },
};

export class DeveloperResourcesService {
  constructor({ cloudflareClient, perPage = 50 }) {
    this.cloudflareClient = cloudflareClient;
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

  async list(type, accountId = "") {
    const resourceType = assertResourceType(type);
    const definition = definitions[resourceType];
    const resolved = await this.resolveAccountId(accountId);
    const resources = await this.listResourceItems(definition, resolved.accountId);

    return {
      accounts: resolved.accounts,
      accountId: resolved.accountId,
      type: resourceType,
      items: resources.map(definition.normalize),
      warnings: [],
    };
  }

  async listResourceItems(definition, accountId) {
    return readCloudflareList({ client: this.cloudflareClient, path: definition.listPath(accountId),
      perPage: definition.perPage || this.perPage, query: definition.listQuery || {}, keys: definition.listKeys,
      identity: item => definition.normalize(item).id, pagination: definition.pagination || "page",
      errorMessage: "Cloudflare 资源列表读取失败" });
  }

  async create(type, accountId = "", input = {}) {
    const resourceType = assertResourceType(type);
    const definition = definitions[resourceType];
    const resolved = await this.resolveAccountId(accountId);
    const body = definition.createBody(input);
    const path =
      typeof definition.createPath === "function"
        ? definition.createPath(resolved.accountId, input)
        : definition.createPath;
    const payload = await this.cloudflareClient[definition.createMethod](path, body);
    const result = payload.result?.bucket || payload.result || { ...body, name: input.name };
    const normalized = definition.normalize(result);

    return {
      accountId: resolved.accountId,
      type: resourceType,
      item: normalized.id ? normalized : definition.normalize({ ...body, name: input.name }),
    };
  }

  async delete(type, accountId = "", resourceId = "") {
    const resourceType = assertResourceType(type);
    const definition = definitions[resourceType];
    const resolved = await this.resolveAccountId(accountId);
    const normalizedId = definition.normalizeId(decodeURIComponent(String(resourceId || "")));

    await this.cloudflareClient.deleteAny(
      definition.deletePath(resolved.accountId, normalizedId)
    );

    return { accountId: resolved.accountId, type: resourceType, id: normalizedId };
  }

  async getDetail(type, accountId = "", resourceId = "") {
    const resourceType = assertResourceType(type);
    const definition = definitions[resourceType];
    const resolved = await this.resolveAccountId(accountId);
    const id = definition.normalizeId(decodeURIComponent(String(resourceId || "")));
    const warnings = [];
    const detail = {
      accountId: resolved.accountId,
      accounts: resolved.accounts,
      type: resourceType,
      id,
      item: null,
      extras: {},
      warnings,
    };

    if (resourceType === "pages") {
      detail.item = await this.getPagesProject(resolved.accountId, id);
      detail.extras.deployments = await this.listPagesDeployments(resolved.accountId, id).catch(
        (error) => {
          warnings.push(`部署记录读取失败：${error.message}`);
          return [];
        }
      );
      detail.extras.domains = await this.listPagesDomains(resolved.accountId, id).catch(
        (error) => {
          warnings.push(`自定义域读取失败：${error.message}`);
          return [];
        }
      );
      return detail;
    }

    if (resourceType === "d1") {
      detail.item = await this.getD1Database(resolved.accountId, id);
      detail.extras.tables = await this.listD1Tables(resolved.accountId, id).catch((error) => {
        warnings.push(`表列表读取失败：${error.message}`);
        return [];
      });
      return detail;
    }

    if (resourceType === "r2") {
      detail.item = await this.getR2Bucket(resolved.accountId, id);
      detail.extras.objects = await this.listR2Objects(resolved.accountId, id).catch((error) => {
        warnings.push(`对象列表读取失败：${error.message}`);
        return [];
      });
      return detail;
    }

    if (resourceType === "kv") {
      detail.item = await this.getKvNamespace(resolved.accountId, id);
      detail.extras.keys = [];
      detail.extras.keyPage = { cursor: "", hasMore: false, prefix: "", limit: 50, failed: true };
      try {
        const page = await this.readKvKeysPage(resolved.accountId, id);
        detail.extras.keys = page.keys;
        detail.extras.keyPage = { cursor: page.cursor, hasMore: page.hasMore, prefix: page.prefix, limit: page.limit };
      } catch (error) {
        warnings.push(`Key 列表读取失败：${error.message}`);
      }
      return detail;
    }

    detail.item = await this.getTunnel(resolved.accountId, id);
    detail.extras.configuration = await this.getTunnelConfiguration(resolved.accountId, id).catch(
      (error) => {
        warnings.push(`Tunnel ingress 配置读取失败：${error.message}`);
        return null;
      }
    );
    return detail;
  }

  async getPagesProject(accountId, projectName) {
    const payload = await this.cloudflareClient.get(
      `accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}`
    );

    return normalizePagesProject(payload.result || {});
  }

  async listPagesDeployments(accountId, projectName) {
    const payload = await this.cloudflareClient.get(
      `accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}/deployments`,
      { page: 1, per_page: 10 }
    );
    const deployments = listFromPayload(payload, ["deployments"]) || [];

    return deployments.map(normalizePagesDeployment);
  }

  async listPagesDomains(accountId, projectName) {
    const payload = await this.cloudflareClient.get(
      `accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}/domains`
    );
    const domains = listFromPayload(payload, ["domains"]) || [];

    return domains.map(normalizePagesDomain);
  }

  async updatePagesBuildConfig(accountId = "", projectName = "", input = {}) {
    const resolved = await this.resolveAccountId(accountId);
    const normalizedProjectName = definitions.pages.normalizeId(projectName);
    const body = {};

    if (input.productionBranch !== undefined) {
      body.production_branch = String(input.productionBranch || "").trim() || "main";
    }

    if (input.buildCommand !== undefined || input.destinationDir !== undefined || input.rootDir !== undefined) {
      body.build_config = {
        ...(input.buildCommand !== undefined
          ? { build_command: String(input.buildCommand || "").trim() }
          : {}),
        ...(input.destinationDir !== undefined
          ? { destination_dir: String(input.destinationDir || "").trim() }
          : {}),
        ...(input.rootDir !== undefined ? { root_dir: String(input.rootDir || "").trim() } : {}),
      };
    }

    if (Object.keys(body).length === 0) {
      throw new HttpError(400, "没有可保存的 Pages 构建配置");
    }

    const payload = await this.cloudflareClient.patch(
      `accounts/${resolved.accountId}/pages/projects/${encodeURIComponent(normalizedProjectName)}`,
      body
    );

    return {
      accountId: resolved.accountId,
      item: normalizePagesProject(payload.result || {}),
    };
  }

  async getD1Database(accountId, databaseId) {
    assertCloudflareResourceId(databaseId, "D1 数据库 ID");
    const payload = await this.cloudflareClient.get(`accounts/${accountId}/d1/database/${databaseId}`);

    return normalizeD1Database(payload.result || {});
  }

  async queryD1(accountId = "", databaseId = "", input = {}, options = {}) {
    return this.executeD1Query(accountId, databaseId, input, options);
  }

  async executeD1Query(accountId = "", databaseId = "", input = {}, options = {}) {
    const resolved = await this.resolveAccountId(accountId);
    assertCloudflareResourceId(databaseId, "D1 数据库 ID");
    const sql = String(input.sql || "").trim();

    if (!sql || sql.length > 10000) {
      throw new HttpError(400, "SQL 不能为空，且长度不能超过 10000");
    }

    assertD1SqlAllowed(sql, { allowMutations: Boolean(options.allowMutations) });

    const payload = await this.cloudflareClient.post(
      `accounts/${resolved.accountId}/d1/database/${databaseId}/query`,
      {
        sql,
        params: Array.isArray(input.params) ? input.params : [],
      }
    );
    const results = Array.isArray(payload.result) ? payload.result : [payload.result || {}];

    return {
      accountId: resolved.accountId,
      databaseId,
      results: results.map(normalizeD1QueryResult),
    };
  }

  async listD1Tables(accountId, databaseId) {
    const payload = await this.executeD1Query(accountId, databaseId, {
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    });

    return payload.results.flatMap((result) =>
      result.results.map((row) => String(row.name || "")).filter(Boolean)
    );
  }

  async getR2Bucket(accountId, bucketName) {
    const normalizedBucketName = definitions.r2.normalizeId(bucketName);
    const payload = await this.cloudflareClient.get(
      `accounts/${accountId}/r2/buckets/${normalizedBucketName}`
    );

    return normalizeR2Bucket(payload.result || { name: normalizedBucketName });
  }

  async listR2Objects(accountId, bucketName, options = {}) {
    const normalizedBucketName = definitions.r2.normalizeId(bucketName);
    const payload = await this.cloudflareClient.get(
      `accounts/${accountId}/r2/buckets/${normalizedBucketName}/objects`,
      {
        prefix: options.prefix,
        delimiter: options.delimiter,
        cursor: options.cursor,
        per_page: options.perPage || 50,
      }
    );
    const objects = listFromPayload(payload, ["objects"]) || [];

    return objects.map(normalizeR2Object);
  }

  async putR2Object(accountId = "", bucketName = "", input = {}) {
    const resolved = await this.resolveAccountId(accountId);
    const normalizedBucketName = definitions.r2.normalizeId(bucketName);
    const key = assertR2ObjectKey(input.key);
    const content = String(input.content ?? "");
    const response = await this.cloudflareClient.putRaw(
      `accounts/${resolved.accountId}/r2/buckets/${normalizedBucketName}/objects/${encodeURIComponent(key)}`,
      content,
      {
        "Content-Type": String(input.contentType || "application/octet-stream"),
      }
    );

    return {
      accountId: resolved.accountId,
      bucketName: normalizedBucketName,
      key,
      etag: response.headers.get("etag") || "",
    };
  }

  async deleteR2Object(accountId = "", bucketName = "", key = "") {
    const resolved = await this.resolveAccountId(accountId);
    const normalizedBucketName = definitions.r2.normalizeId(bucketName);
    const normalizedKey = assertR2ObjectKey(key);

    await this.cloudflareClient.deleteAny(
      `accounts/${resolved.accountId}/r2/buckets/${normalizedBucketName}/objects/${encodeURIComponent(normalizedKey)}`
    );

    return { accountId: resolved.accountId, bucketName: normalizedBucketName, key: normalizedKey };
  }

  async getKvNamespace(accountId, namespaceId) {
    assertCloudflareResourceId(namespaceId, "KV 命名空间 ID");
    const payload = await this.cloudflareClient.get(
      `accounts/${accountId}/storage/kv/namespaces/${namespaceId}`
    );

    return normalizeKvNamespace(payload.result || { id: namespaceId });
  }

  async listKvKeys(accountId, namespaceId, options = {}) {
    return (await this.readKvKeysPage(accountId, namespaceId, options)).keys;
  }

  async listKvKeysPage(accountId = "", namespaceId, options = {}) {
    assertCloudflareResourceId(namespaceId, "KV 命名空间 ID");
    const query = kvPageOptions(options);
    const resolved = await this.resolveAccountId(accountId);
    return this.readKvKeysPage(resolved.accountId, namespaceId, query);
  }

  async readKvKeysPage(accountId, namespaceId, options = {}) {
    assertCloudflareId(accountId, "账号 ID");
    assertCloudflareResourceId(namespaceId, "KV 命名空间 ID");
    const query = kvPageOptions(options);
    const payload = await this.cloudflareClient.get(
      `accounts/${accountId}/storage/kv/namespaces/${namespaceId}/keys`,
      query
    );
    const keys = listFromPayload(payload, ["keys"]);
    const cursor = payload.result_info?.cursor ?? "";
    if (!Array.isArray(keys) || keys.some(key => typeof key?.name !== "string" || !key.name) ||
        typeof cursor !== "string" || Buffer.byteLength(cursor) > 4096 || (cursor && cursor === query.cursor)) {
      throw new HttpError(502, "Cloudflare KV Key 列表或分页游标异常，请刷新列表后重试。");
    }
    return { accountId, namespaceId, keys: keys.map(normalizeKvKey), prefix: query.prefix, limit: query.limit,
      cursor, hasMore: Boolean(cursor) };
  }

  async getKvValue(accountId = "", namespaceId = "", key = "") {
    const resolved = await this.resolveAccountId(accountId);
    assertCloudflareResourceId(namespaceId, "KV 命名空间 ID");
    const normalizedKey = assertKvKey(key);
    const response = await this.cloudflareClient.getRaw(
      `accounts/${resolved.accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(normalizedKey)}`,
      {},
      { Accept: "text/plain,*/*" }
    );

    return {
      accountId: resolved.accountId,
      namespaceId,
      key: normalizedKey,
      value: await response.text(),
      contentType: response.headers.get("content-type") || "",
    };
  }

  async putKvValue(accountId = "", namespaceId = "", input = {}) {
    const resolved = await this.resolveAccountId(accountId);
    assertCloudflareResourceId(namespaceId, "KV 命名空间 ID");
    const key = assertKvKey(input.key);
    const value = String(input.value ?? "");
    await this.cloudflareClient.putRaw(
      `accounts/${resolved.accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
      value,
      { "Content-Type": "text/plain; charset=utf-8" }
    );

    return { accountId: resolved.accountId, namespaceId, key };
  }

  async deleteKvValue(accountId = "", namespaceId = "", key = "") {
    const resolved = await this.resolveAccountId(accountId);
    assertCloudflareResourceId(namespaceId, "KV 命名空间 ID");
    const normalizedKey = assertKvKey(key);
    await this.cloudflareClient.deleteAny(
      `accounts/${resolved.accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(normalizedKey)}`
    );

    return { accountId: resolved.accountId, namespaceId, key: normalizedKey };
  }

  async getTunnel(accountId, tunnelId) {
    assertCloudflareResourceId(tunnelId, "Tunnel ID");
    const payload = await this.cloudflareClient.get(`accounts/${accountId}/cfd_tunnel/${tunnelId}`);

    return normalizeTunnel(payload.result || { id: tunnelId });
  }

  async getTunnelConfiguration(accountId, tunnelId) {
    assertCloudflareResourceId(tunnelId, "Tunnel ID");
    const payload = await this.cloudflareClient.get(
      `accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`
    );

    return payload.result || null;
  }

  async updateTunnelConfiguration(accountId = "", tunnelId = "", input = {}) {
    const resolved = await this.resolveAccountId(accountId);
    assertCloudflareResourceId(tunnelId, "Tunnel ID");
    const config = input.config || {
      ingress: Array.isArray(input.ingress) ? input.ingress : [],
      warp_routing: input.warpRouting || input.warp_routing || { enabled: false },
    };

    if (!Array.isArray(config.ingress)) {
      throw new HttpError(400, "Tunnel ingress 配置必须是数组");
    }

    const payload = await this.cloudflareClient.put(
      `accounts/${resolved.accountId}/cfd_tunnel/${tunnelId}/configurations`,
      { config }
    );

    return {
      accountId: resolved.accountId,
      tunnelId,
      configuration: payload.result || null,
    };
  }

  async getTunnelToken(accountId = "", tunnelId = "") {
    const resolved = await this.resolveAccountId(accountId);
    assertCloudflareResourceId(tunnelId, "Tunnel ID");
    const token = await this.cloudflareClient.getText(
      `accounts/${resolved.accountId}/cfd_tunnel/${tunnelId}/token`
    );

    return { accountId: resolved.accountId, tunnelId, token };
  }
}
