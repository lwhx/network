import { HttpError } from "../../lib/http-error.js";
import { normalizeDnsRecord } from "./dns-record-normalizer.js";

const supportedRecordTypes = new Set(["A", "AAAA", "CNAME", "TXT", "MX", "NS"]);
const proxiableRecordTypes = new Set(["A", "AAAA", "CNAME"]);
const zoneIdPattern = /^[a-z0-9]{32}$/i;
const recordIdPattern = /^[a-z0-9]{32}$/i;
const maxBulkRecords = 100;

function assertCloudflareId(value, label, pattern = zoneIdPattern) {
  if (!pattern.test(String(value || ""))) {
    throw new HttpError(400, `${label} 无效`);
  }
}

function normalizeRecordInput(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "DNS 记录必须是有效的对象");
  }

  const record = {};
  const type = String(input.type || "").trim().toUpperCase();

  if (!partial || type) {
    if (!supportedRecordTypes.has(type)) {
      throw new HttpError(400, "DNS 记录类型暂不支持");
    }

    record.type = type;
  }

  if (!partial || input.name !== undefined) {
    const name = String(input.name || "").trim();

    if (!name || name.length > 255) {
      throw new HttpError(400, "DNS 记录名称不能为空，且长度不能超过 255");
    }

    record.name = name;
  }

  if (!partial || input.content !== undefined) {
    const content = String(input.content || "").trim();

    if (!content || content.length > 4096) {
      throw new HttpError(400, "DNS 记录内容不能为空，且长度不能超过 4096");
    }

    record.content = content;
  }

  if (!partial || input.ttl !== undefined) {
    const ttl = Number(input.ttl ?? 1);

    if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 60 || ttl > 86400))) {
      throw new HttpError(400, "TTL 必须为 1（自动）或 60 到 86400 秒");
    }

    record.ttl = ttl;
  }

  const effectiveType = record.type || String(input.currentType || "").trim().toUpperCase();

  if (input.priority !== undefined && input.priority !== "") {
    const priority = Number(input.priority);

    if (!Number.isInteger(priority) || priority < 0 || priority > 65535) {
      throw new HttpError(400, "优先级必须是 0 到 65535 的整数");
    }

    record.priority = priority;
  } else if (!partial && effectiveType === "MX") {
    record.priority = 10;
  }

  if (input.proxied !== undefined && proxiableRecordTypes.has(effectiveType)) {
    record.proxied = Boolean(input.proxied);
  }

  if (input.comment !== undefined) {
    const comment = String(input.comment || "").trim();

    if (comment.length > 500) {
      throw new HttpError(400, "备注长度不能超过 500");
    }

    record.comment = comment;
  }

  return record;
}

function sameDnsValue(left, right) {
  return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}

function validateCreateInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new HttpError(400, "请至少提供一条 DNS 记录");
  }

  if (inputs.length > maxBulkRecords) {
    throw new HttpError(400, `单次最多批量添加 ${maxBulkRecords} 条 DNS 记录`);
  }

  return inputs.map((input) => normalizeRecordInput(input));
}

function validateDeleteIds(recordIds) {
  if (!Array.isArray(recordIds) || recordIds.length === 0) {
    throw new HttpError(400, "请选择要删除的 DNS 记录");
  }

  if (recordIds.length > maxBulkRecords) {
    throw new HttpError(400, `单次最多批量删除 ${maxBulkRecords} 条 DNS 记录`);
  }

  return recordIds.map((recordId) => {
    const normalizedId = String(recordId || "").trim();
    assertCloudflareId(normalizedId, "DNS 记录 ID", recordIdPattern);
    return normalizedId;
  });
}

function bulkSummary(results) {
  const summary = { total: results.length, succeeded: 0, failed: 0, unknown: 0, skipped: 0 };

  for (const { status } of results) {
    summary[status === "success" ? "succeeded" : status] += 1;
  }

  return summary;
}

function bulkFailure(error) {
  const unknown = Boolean(error?.remoteOutcomeUnknown);
  return {
    status: unknown ? "unknown" : "failed",
    error: error?.message || "DNS 操作失败，请稍后重试。",
    retryable: !unknown,
  };
}

function skippedOperation() {
  return {
    status: "skipped",
    error: "前一条操作结果未知，已停止后续操作。请先刷新并核对 DNS 记录。",
    retryable: true,
  };
}

function assertDnsWriteResult(result, fields = ["id"]) {
  if (
    !result || typeof result !== "object" || Array.isArray(result) ||
    fields.some((field) => typeof result[field] !== "string" || !result[field].trim())
  ) {
    const error = new HttpError(502, "Cloudflare DNS 操作返回格式异常，结果未知。请先刷新并核对 DNS 记录。");
    error.remoteOutcomeUnknown = true;
    throw error;
  }
}

export class DnsRecordsService {
  constructor({ cloudflareClient, perPage = 100 }) {
    this.cloudflareClient = cloudflareClient;
    this.perPage = perPage;
  }

  async listRecords(zoneId) {
    assertCloudflareId(zoneId, "区域 ID");

    const records = [];
    let page = 1;
    let totalPages = 1;

    do {
      const payload = await this.cloudflareClient.get(`zones/${zoneId}/dns_records`, {
        page,
        per_page: this.perPage,
        order: "type",
        direction: "asc",
      });

      if (!Array.isArray(payload.result)) {
        throw new HttpError(502, "Cloudflare API 返回格式异常，请稍后重试。");
      }

      records.push(...payload.result.map(normalizeDnsRecord));

      const reportedTotalPages = Number(payload.result_info?.total_pages);
      totalPages =
        Number.isFinite(reportedTotalPages) && reportedTotalPages >= page
          ? reportedTotalPages
          : page;
      page += 1;
    } while (page <= totalPages);

    return records;
  }

  async createRecord(zoneId, input) {
    assertCloudflareId(zoneId, "区域 ID");
    const payload = await this.cloudflareClient.post(
      `zones/${zoneId}/dns_records`,
      normalizeRecordInput(input)
    );

    assertDnsWriteResult(payload?.result, ["id", "type", "name", "content"]);
    return normalizeDnsRecord(payload.result);
  }

  async createRecords(zoneId, inputs = []) {
    assertCloudflareId(zoneId, "区域 ID");
    const normalizedInputs = validateCreateInputs(inputs);
    const records = [];

    for (const input of normalizedInputs) {
      records.push(await this.createRecord(zoneId, input));
    }

    return records;
  }

  async createRecordsDetailed(zoneId, inputs = []) {
    assertCloudflareId(zoneId, "区域 ID");
    const normalizedInputs = validateCreateInputs(inputs);
    const records = [];
    const results = [];
    let stopped = false;

    for (const [index, input] of normalizedInputs.entries()) {
      if (stopped) {
        results.push({ index, input, ...skippedOperation() });
        continue;
      }

      try {
        const record = await this.createRecord(zoneId, input);
        records.push(record);
        results.push({ index, input, status: "success", record, retryable: false });
      } catch (error) {
        const failure = bulkFailure(error);
        results.push({ index, input, ...failure });
        stopped = failure.status === "unknown";
      }
    }

    return { records, results, summary: bulkSummary(results) };
  }

  async upsertCnameRecord(zoneId, input = {}) {
    assertCloudflareId(zoneId, "区域 ID");
    const recordBody = normalizeRecordInput({
      ttl: 1,
      proxied: false,
      ...input,
      type: "CNAME",
    });
    const records = await this.listRecords(zoneId);
    const existingRecords = records.filter((record) => record.name === recordBody.name);
    const blockingRecords = existingRecords.filter((record) => record.type !== "CNAME");

    if (blockingRecords.length > 0) {
      const types = [...new Set(blockingRecords.map((record) => record.type).filter(Boolean))]
        .join("、");

      throw new HttpError(
        409,
        `${recordBody.name} 已存在 ${types || "其它"} 解析，请先清理后再添加 Worker 优选`
      );
    }

    if (existingRecords.length > 1) {
      throw new HttpError(
        409,
        `${recordBody.name} 存在多条 CNAME 解析，请先保留一条后再添加 Worker 优选`
      );
    }

    if (existingRecords.length === 1) {
      const [record] = existingRecords;

      if (
        sameDnsValue(record.content, recordBody.content) &&
        record.ttl === recordBody.ttl &&
        record.proxied === false &&
        sameDnsValue(record.comment, recordBody.comment)
      ) {
        return record;
      }

      return this.updateRecord(zoneId, record.id, recordBody);
    }

    return this.createRecord(zoneId, recordBody);
  }

  async updateRecord(zoneId, recordId, input) {
    assertCloudflareId(zoneId, "区域 ID");
    assertCloudflareId(recordId, "DNS 记录 ID", recordIdPattern);
    const payload = await this.cloudflareClient.patch(
      `zones/${zoneId}/dns_records/${recordId}`,
      normalizeRecordInput(input)
    );

    return normalizeDnsRecord(payload.result);
  }

  async deleteRecord(zoneId, recordId) {
    assertCloudflareId(zoneId, "区域 ID");
    assertCloudflareId(recordId, "DNS 记录 ID", recordIdPattern);
    const payload = await this.cloudflareClient.delete(
      `zones/${zoneId}/dns_records/${recordId}`
    );

    if (payload?.httpStatus === 204) {
      return { id: recordId };
    }

    assertDnsWriteResult(payload?.result);
    return { id: payload.result.id };
  }

  async deleteRecords(zoneId, recordIds = []) {
    assertCloudflareId(zoneId, "区域 ID");
    const uniqueRecordIds = [...new Set(validateDeleteIds(recordIds))];
    const deleted = [];

    for (const recordId of uniqueRecordIds) {
      deleted.push(await this.deleteRecord(zoneId, recordId));
    }

    return deleted;
  }

  async deleteRecordsDetailed(zoneId, recordIds = []) {
    assertCloudflareId(zoneId, "区域 ID");
    const normalizedIds = validateDeleteIds(recordIds);
    const deleted = [];
    const results = [];
    const outcomes = new Map();
    let stopped = false;

    for (const [index, recordId] of normalizedIds.entries()) {
      let outcome = outcomes.get(recordId);

      if (!outcome) {
        if (stopped) {
          outcome = skippedOperation();
        } else {
          try {
            const result = await this.deleteRecord(zoneId, recordId);
            deleted.push(result);
            outcome = { status: "success", result, retryable: false };
          } catch (error) {
            outcome = bulkFailure(error);
            stopped = outcome.status === "unknown";
          }
        }

        outcomes.set(recordId, outcome);
      }

      results.push({ index, recordId, ...outcome });
    }

    return { deleted, results, summary: bulkSummary(results) };
  }
}
