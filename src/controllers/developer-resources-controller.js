import { HttpError } from "../lib/http-error.js";
import { readJsonBody } from "../lib/request-body.js";
import { assertD1SqlAllowed } from "../lib/sql-safety.js";

export class DeveloperResourcesController {
  constructor({
    d1SqlConsoleAllowMutations = false,
    d1SqlConsoleEnabled = false,
    developerResourcesService,
  }) {
    this.d1SqlConsoleAllowMutations = Boolean(d1SqlConsoleAllowMutations);
    this.d1SqlConsoleEnabled = Boolean(d1SqlConsoleEnabled);
    this.developerResourcesService = developerResourcesService;
  }

  list = async ({ params, url }) => {
    const resources = await this.developerResourcesService.list(
      params.type,
      url.searchParams.get("accountId")
    );
    return { statusCode: 200, body: { resources } };
  };

  create = async ({ params, request, url }) => {
    const body = await readJsonBody(request);

    if (!body.name) {
      throw new HttpError(400, "缺少资源名称");
    }

    const resource = await this.developerResourcesService.create(
      params.type,
      body.accountId || url.searchParams.get("accountId"),
      body
    );
    return { statusCode: 201, body: { resource } };
  };

  delete = async ({ params, url }) => {
    const result = await this.developerResourcesService.delete(
      params.type,
      url.searchParams.get("accountId"),
      params.resourceId
    );
    return { statusCode: 200, body: result };
  };

  detail = async ({ params, url }) => {
    const resource = await this.developerResourcesService.getDetail(
      params.type,
      url.searchParams.get("accountId"),
      params.resourceId
    );
    return { statusCode: 200, body: { resource } };
  };

  updatePagesBuildConfig = async ({ params, request, url }) => {
    const body = await readJsonBody(request);
    const resource = await this.developerResourcesService.updatePagesBuildConfig(
      body.accountId || url.searchParams.get("accountId"),
      params.resourceId,
      body
    );
    return { statusCode: 200, body: { resource } };
  };

  queryD1 = async ({ params, request, url }) => {
    if (!this.d1SqlConsoleEnabled) {
      throw new HttpError(403, "D1 SQL 控制台默认关闭，请设置 ENABLE_D1_SQL_CONSOLE=true 后再使用。");
    }

    const body = await readJsonBody(request, { maxBytes: 64 * 1024 });
    assertD1SqlAllowed(body.sql, { allowMutations: this.d1SqlConsoleAllowMutations });
    const result = await this.developerResourcesService.queryD1(
      body.accountId || url.searchParams.get("accountId"),
      params.resourceId,
      body,
      { allowMutations: this.d1SqlConsoleAllowMutations }
    );
    return { statusCode: 200, body: { result } };
  };

  putR2Object = async ({ params, request, url }) => {
    const body = await readJsonBody(request, { maxBytes: 1024 * 1024 });
    const result = await this.developerResourcesService.putR2Object(
      body.accountId || url.searchParams.get("accountId"),
      params.resourceId,
      body
    );
    return { statusCode: 200, body: { result } };
  };

  deleteR2Object = async ({ params, url }) => {
    const result = await this.developerResourcesService.deleteR2Object(
      url.searchParams.get("accountId"),
      params.resourceId,
      url.searchParams.get("key")
    );
    return { statusCode: 200, body: result };
  };

  listKvKeys = async ({ params, url }) => {
    const page = await this.developerResourcesService.listKvKeysPage(
      url.searchParams.get("accountId"), params.resourceId,
      { prefix: url.searchParams.get("prefix"), cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") }
    );
    return { statusCode: 200, body: { page } };
  };

  getKvValue = async ({ params, url }) => {
    const value = await this.developerResourcesService.getKvValue(
      url.searchParams.get("accountId"),
      params.resourceId,
      url.searchParams.get("key")
    );
    return { statusCode: 200, body: { value } };
  };

  putKvValue = async ({ params, request, url }) => {
    const body = await readJsonBody(request, { maxBytes: 256 * 1024 });
    const result = await this.developerResourcesService.putKvValue(
      body.accountId || url.searchParams.get("accountId"),
      params.resourceId,
      body
    );
    return { statusCode: 200, body: { result } };
  };

  deleteKvValue = async ({ params, url }) => {
    const result = await this.developerResourcesService.deleteKvValue(
      url.searchParams.get("accountId"),
      params.resourceId,
      url.searchParams.get("key")
    );
    return { statusCode: 200, body: result };
  };

  updateTunnelConfiguration = async ({ params, request, url }) => {
    const body = await readJsonBody(request, { maxBytes: 64 * 1024 });
    const result = await this.developerResourcesService.updateTunnelConfiguration(
      body.accountId || url.searchParams.get("accountId"),
      params.resourceId,
      body
    );
    return { statusCode: 200, body: { result } };
  };

  getTunnelToken = async ({ params, url }) => {
    const token = await this.developerResourcesService.getTunnelToken(
      url.searchParams.get("accountId"),
      params.resourceId
    );
    return { statusCode: 200, body: { token } };
  };
}
