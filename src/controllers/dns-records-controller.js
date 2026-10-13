import { HttpError } from "../lib/http-error.js";
import { readJsonBody } from "../lib/request-body.js";

export class DnsRecordsController {
  constructor({ dnsRecordsService }) {
    this.dnsRecordsService = dnsRecordsService;
  }

  list = async ({ params }) => {
    const records = await this.dnsRecordsService.listRecords(params.zoneId);
    return { statusCode: 200, body: { records } };
  };

  create = async ({ request, params }) => {
    const body = await readJsonBody(request);
    const record = await this.dnsRecordsService.createRecord(params.zoneId, body);
    return { statusCode: 201, body: { record } };
  };

  createBulk = async ({ request, params }) => {
    const body = await readJsonBody(request);
    const result = await this.dnsRecordsService.createRecordsDetailed(
      params.zoneId,
      Array.isArray(body) ? body : body?.records
    );
    return {
      statusCode: result.summary.succeeded === result.summary.total ? 201 : 207,
      body: result,
    };
  };

  update = async ({ request, params }) => {
    if (!params.recordId) {
      throw new HttpError(400, "缺少 DNS 记录 ID");
    }

    const body = await readJsonBody(request);
    const record = await this.dnsRecordsService.updateRecord(
      params.zoneId,
      params.recordId,
      body
    );
    return { statusCode: 200, body: { record } };
  };

  delete = async ({ params }) => {
    if (!params.recordId) {
      throw new HttpError(400, "缺少 DNS 记录 ID");
    }

    const result = await this.dnsRecordsService.deleteRecord(params.zoneId, params.recordId);
    return { statusCode: 200, body: result };
  };

  deleteBulk = async ({ request, params }) => {
    const body = await readJsonBody(request);
    const result = await this.dnsRecordsService.deleteRecordsDetailed(
      params.zoneId,
      Array.isArray(body) ? body : body?.recordIds
    );
    return {
      statusCode: result.summary.succeeded === result.summary.total ? 200 : 207,
      body: result,
    };
  };
}
