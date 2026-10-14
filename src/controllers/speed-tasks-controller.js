import { HttpError } from "../lib/http-error.js";
import { readJsonBody } from "../lib/request-body.js";

export class SpeedTasksController {
  constructor({ speedDeployService, credentialSessionService }) {
    this.speedDeployService = speedDeployService;
    this.credentialSessionService = credentialSessionService;
  }

  requireSession(request) {
    if (!this.credentialSessionService.getCredentials(request)?.authenticated) throw new HttpError(401, "请先登录面板。");
  }

  list = async ({ request, url }) => {
    this.requireSession(request);
    return { statusCode: 200, body: { tasks: this.speedDeployService.listTasks({ zoneId: url.searchParams.get("zoneId") || "" }) } };
  };

  inspect = async ({ request, params }) => {
    this.requireSession(request);
    const task = await this.speedDeployService.inspectTask(params.taskId);
    this.requireSession(request);
    return { statusCode: 200, body: { task } };
  };

  async confirm(request) {
    this.requireSession(request);
    const body = await readJsonBody(request);
    this.requireSession(request);
    if (body?.confirmation !== "yes") throw new HttpError(400, "请确认恢复或人工处理操作。");
  }

  recover = async ({ request, params }) => {
    await this.confirm(request);
    const task = await this.speedDeployService.recoverTask(params.taskId);
    return { statusCode: 200, body: { task } };
  };

  resolve = async ({ request, params }) => {
    await this.confirm(request);
    const task = this.speedDeployService.resolveManualTask(params.taskId);
    return { statusCode: 200, body: { task } };
  };
}
