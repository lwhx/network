import { readJsonBody } from "../lib/request-body.js";

export class SpeedDeployController {
  constructor({ speedDeployService }) {
    this.speedDeployService = speedDeployService;
  }

  deploy = async ({ request, params }) => {
    const body = await readJsonBody(request);
    try {
      const deployment = await this.speedDeployService.deploy(params.zoneId, body);
      return { statusCode: 200, body: { deployment } };
    } catch (error) {
      if (!error.rollback && !error.taskId) throw error;
      return {
        statusCode: error.statusCode || 502,
        body: { error: error.message, ...(error.rollback ? { rollback: error.rollback } : {}), ...(error.taskId ? { taskId: error.taskId } : {}) },
      };
    }
  };

  list = async ({ params }) => {
    const speed = await this.speedDeployService.listManagedDomains(params.zoneId);
    return { statusCode: 200, body: { speed } };
  };

  delete = async ({ params }) => {
    try {
      const result = await this.speedDeployService.deleteManagedDomain(params.zoneId, params.accessDomain);
      return { statusCode: 200, body: result };
    } catch (error) {
      if (!error.summary) throw error;
      return { statusCode: error.statusCode || 502, body: { error: error.message, summary: error.summary, taskId: error.taskId } };
    }
  };
}
