export class OperationHistoryController {
  constructor({ operationHistoryService }) {
    this.operationHistoryService = operationHistoryService;
  }

  list = async ({ url }) => {
    const history = this.operationHistoryService.list({
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
      accountId: url.searchParams.get("accountId"),
      zoneId: url.searchParams.get("zoneId"),
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      module: url.searchParams.get("module"),
      status: url.searchParams.get("status"),
    });

    return { statusCode: 200, body: { history } };
  };

  clear = async () => {
    return {
      statusCode: 200,
      body: { history: this.operationHistoryService.clear() },
    };
  };
}
