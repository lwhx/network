import {
  createDnsRecordsBulk,
  createDnsRecord,
  fetchDnsRecords,
  removeDnsRecordsBulk,
  removeDnsRecord,
  updateDnsRecord,
} from "../api.js";
import { proxiableTypes } from "../constants.js";
import { filterDnsRecords } from "../dns-record-filter.js";
import { collectDnsForm, fillDnsFormFromRecord } from "../forms/dns-form.js";
import { resetDnsBulkForm, resetDnsForm, state } from "../state.js";
import { beginScopedRequest, captureRequestContext } from "../request-scope.js";

const bulkBooleanValues = new Map([
  ["true", true],
  ["yes", true],
  ["y", true],
  ["1", true],
  ["on", true],
  ["proxy", true],
  ["proxied", true],
  ["orange", true],
  ["false", false],
  ["no", false],
  ["n", false],
  ["0", false],
  ["off", false],
  ["dns", false],
  ["gray", false],
]);

function splitBulkLine(line) {
  const tokens = [];
  let token = "";
  let quote = "";
  let escaped = false;

  for (const char of line) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        token += char;
      }

      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }

      continue;
    }

    token += char;
  }

  if (quote) {
    throw new Error("引号未闭合");
  }

  if (escaped) {
    token += "\\";
  }

  if (token) {
    tokens.push(token);
  }

  return tokens;
}

function readBulkBoolean(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!bulkBooleanValues.has(normalized)) {
    throw new Error("代理状态只能填写 true/false、on/off 或 1/0");
  }

  return bulkBooleanValues.get(normalized);
}

function isBulkBoolean(value) {
  return bulkBooleanValues.has(String(value || "").trim().toLowerCase());
}

function parseBulkTtl(value, lineNumber) {
  if (value === undefined || value === "") {
    return 1;
  }

  const ttl = Number(value);

  if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 60 || ttl > 86400))) {
    throw new Error(`第 ${lineNumber} 行 TTL 必须为 1 或 60 到 86400 的整数`);
  }

  return ttl;
}

export function parseDnsBulkText(text) {
  const records = [];

  String(text || "")
    .split(/\r?\n/)
    .forEach((rawLine, index) => {
      const line = rawLine.trim();

      if (!line || line.startsWith("#")) {
        return;
      }

      const tokens = splitBulkLine(line);

      if (tokens.length < 3) {
        throw new Error(`第 ${index + 1} 行格式不完整，请填写：类型 名称 内容`);
      }

      if (tokens.length > 6) {
        throw new Error(`第 ${index + 1} 行字段过多，内容包含空格时请使用英文引号包裹`);
      }

      const [typeValue, name, content, ttlValue, proxiedValue, priorityValue] = tokens;
      const type = String(typeValue || "").trim().toUpperCase();
      const record = {
        content,
        name,
        ttl: parseBulkTtl(ttlValue, index + 1),
        type,
      };

      if (proxiedValue !== undefined && proxiedValue !== "" && isBulkBoolean(proxiedValue)) {
        record.proxied = readBulkBoolean(proxiedValue);
      } else if (type === "MX" && proxiedValue !== undefined && priorityValue === undefined) {
        record.priority = proxiedValue;
      } else if (proxiedValue !== undefined && proxiedValue !== "") {
        throw new Error(`第 ${index + 1} 行代理状态只能填写 true/false、on/off 或 1/0`);
      }

      if (priorityValue !== undefined && priorityValue !== "") {
        record.priority = priorityValue;
      }

      records.push(record);
    });

  if (records.length === 0) {
    throw new Error("请输入至少一条 DNS 记录");
  }

  if (records.length > 100) {
    throw new Error("单次最多批量添加 100 条 DNS 记录");
  }

  return records;
}

export function createDnsActions({ renderApp }) {
  async function loadDnsRecords() {
    if (!state.selectedZone?.id) {
      return;
    }
    const zoneId = state.selectedZone.id;
    const request = beginScopedRequest("dns", () => state.selectedZone?.id || "");
    state.dnsRecords = [];
    if (state.dnsBulkResult?.zoneId !== zoneId) state.dnsBulkResult = null;

    if (state.dnsSearchZoneId !== state.selectedZone.id) {
      state.dnsSearchQuery = "";
      state.dnsSearchZoneId = state.selectedZone.id;
    }

    state.loadingDns = true;
    state.dnsError = "";
    state.selectedDnsRecordIds = [];
    renderApp();

    try {
      const records = await fetchDnsRecords(zoneId, { signal: request.signal });
      if (!request.isCurrent()) return;
      state.dnsRecords = records;
    } catch (error) {
      if (!request.isCurrent()) return;
      state.dnsError = error.message;
    } finally {
      if (request.isCurrent()) {
        state.loadingDns = false;
        renderApp();
      }
    }
  }

  function resetDnsFormAction() {
    const keepCreateFormOpen = state.dnsFormOpen && !state.dnsForm.id;
    resetDnsForm();
    state.dnsFormOpen = keepCreateFormOpen;
    state.notice = "";
    renderApp();
  }

  function openCreateDnsForm() {
    resetDnsForm();
    resetDnsBulkForm();
    state.dnsFormOpen = true;
    state.notice = "";
    renderApp();
    document.querySelector("#dns-record-form")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  function openDnsBulkForm() {
    resetDnsForm();
    state.dnsBulkFormOpen = true;
    state.notice = "";
    renderApp();
    document.querySelector("#dns-bulk-form")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  function closeDnsBulkForm() {
    resetDnsBulkForm();
    state.notice = "";
    renderApp();
  }

  async function submitDnsBulk(event) {
    event.preventDefault();

    if (!state.selectedZone?.id) {
      return;
    }

    const text = String(new FormData(event.currentTarget).get("records") || "");
    state.dnsBulkText = text;

    let records;

    try {
      records = parseDnsBulkText(text);
    } catch (error) {
      state.notice = error.message;
      renderApp();
      return;
    }

    await runDnsBulk("create", records);
  }

  function summarizeBulk(results) {
    return { total: results.length, succeeded: results.filter((item) => item.status === "success").length,
      failed: results.filter((item) => item.status === "failed").length,
      unknown: results.filter((item) => item.status === "unknown").length,
      skipped: results.filter((item) => item.status === "skipped").length };
  }

  async function runDnsBulk(type, inputs, retryIndices = null) {
    if (!state.selectedZone?.id || state.savingDnsBulk || state.deletingDnsBulk) return;
    const zoneId = state.selectedZone.id;
    const accountId = state.activeCloudflareAccountId;
    const request = captureRequestContext(() => state.selectedZone?.id || "");
    const busyKey = type === "create" ? "savingDnsBulk" : "deletingDnsBulk";
    const previous = state.dnsBulkResult;
    state[busyKey] = true;
    state.notice = "";
    renderApp();
    try {
      const payload = type === "create" ? await createDnsRecordsBulk(zoneId, inputs) : await removeDnsRecordsBulk(zoneId, inputs);
      if (!request.isCurrent()) return;
      const results = retryIndices ? [...previous.results] : payload.results;
      if (retryIndices) {
        payload.results.forEach((item, index) => {
          const originalIndex = retryIndices[index];
          results[originalIndex] = { ...item, index: originalIndex };
        });
      }
      const summary = summarizeBulk(results);
      state.dnsBulkResult = { type, zoneId, accountId, results, summary };
      if (type === "create") resetDnsBulkForm();
      state.selectedDnsRecordIds = [];
      state.notice = `批量${type === "create" ? "添加" : "删除"}：成功 ${summary.succeeded}，失败 ${summary.failed}，结果未确认 ${summary.unknown}，未执行 ${summary.skipped}`;
      await loadDnsRecords();
    } catch (error) {
      if (!request.isCurrent()) return;
      state.notice = `${error.message}；请先刷新记录核查结果，再决定是否重新提交。`;
    } finally {
      if (request.isCurrent()) {
        state[busyKey] = false;
        renderApp();
      }
    }
  }

  async function retryDnsBulk() {
    const result = state.dnsBulkResult;
    if (!result || result.zoneId !== state.selectedZone?.id || result.accountId !== state.activeCloudflareAccountId) return;
    const retryIndices = result.results.map((item, index) => item.retryable ? index : -1).filter((index) => index >= 0);
    if (!retryIndices.length) return;
    if (result.type === "delete" && !window.confirm(`确定重试删除 ${retryIndices.length} 条记录吗？`)) return;
    await runDnsBulk(result.type, retryIndices.map((index) => result.type === "create" ? result.results[index].input : result.results[index].recordId), retryIndices);
  }

  function syncDnsFormType(event) {
    state.dnsForm = collectDnsForm();
    state.dnsForm.type = event.target.value;

    if (!proxiableTypes.has(state.dnsForm.type)) {
      state.dnsForm.proxied = false;
    }

    renderApp();
  }

  async function saveDnsRecord(event) {
    event.preventDefault();

    if (!state.selectedZone?.id) {
      return;
    }

    const record = collectDnsForm();
    const zoneId = state.selectedZone.id;
    const request = captureRequestContext(() => state.selectedZone?.id || "");
    const isEdit = Boolean(record.id);
    state.dnsForm = { ...record, ttl: String(record.ttl) };
    state.savingDns = true;
    state.notice = "";
    renderApp();

    try {
      if (isEdit) {
        await updateDnsRecord(zoneId, record.id, record);
      } else {
        await createDnsRecord(zoneId, record);
      }
      if (!request.isCurrent()) return;
      resetDnsForm();
      state.notice = isEdit ? "DNS 记录已更新" : "DNS 记录已添加";
      await loadDnsRecords();
    } catch (error) {
      if (!request.isCurrent()) return;
      state.notice = error.message;
    } finally {
      if (request.isCurrent()) {
        state.savingDns = false;
        renderApp();
      }
    }
  }

  function editDnsRecord(recordId) {
    const record = state.dnsRecords.find((item) => item.id === recordId);

    if (!record) {
      return;
    }

    fillDnsFormFromRecord(record);
    state.dnsFormOpen = true;
    state.notice = "";
    renderApp();
    document.querySelector("#dns-record-form")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  async function deleteDnsRecord(recordId) {
    const record = state.dnsRecords.find((item) => item.id === recordId);

    if (!record || !state.selectedZone?.id) {
      return;
    }

    const confirmed = window.confirm(`确定删除 ${record.type} ${record.name} 吗？`);

    if (!confirmed) {
      return;
    }
    const zoneId = state.selectedZone.id;
    const request = captureRequestContext(() => state.selectedZone?.id || "");
    try {
      await removeDnsRecord(zoneId, record.id);
      if (!request.isCurrent()) return;
      state.notice = "DNS 记录已删除";
      await loadDnsRecords();
    } catch (error) {
      if (!request.isCurrent()) return;
      state.notice = error.message;
      renderApp();
    }
  }

  function toggleDnsRecordSelection(recordId, checked) {
    const normalizedRecordId = String(recordId || "");

    if (!normalizedRecordId) {
      return;
    }

    const selectedIds = new Set(state.selectedDnsRecordIds);

    if (checked) {
      selectedIds.add(normalizedRecordId);
    } else {
      selectedIds.delete(normalizedRecordId);
    }

    state.selectedDnsRecordIds = [...selectedIds].filter((id) =>
      state.dnsRecords.some((record) => record.id === id)
    );
    renderApp();
  }

  function toggleAllDnsRecords(event) {
    const visibleRecordIds = new Set(
      filterDnsRecords(state.dnsRecords, state.dnsSearchQuery).map((record) => record.id)
    );
    const selectedIds = new Set(state.selectedDnsRecordIds);

    for (const recordId of visibleRecordIds) {
      if (event.target.checked) {
        selectedIds.add(recordId);
      } else {
        selectedIds.delete(recordId);
      }
    }

    state.selectedDnsRecordIds = [...selectedIds].filter((id) =>
      state.dnsRecords.some((record) => record.id === id)
    );
    renderApp();
  }

  function searchDnsRecords(event) {
    const query = String(event?.currentTarget?.value || "");
    const visibleRecordIds = new Set(
      filterDnsRecords(state.dnsRecords, query).map((record) => record.id)
    );

    state.dnsSearchQuery = query;
    state.selectedDnsRecordIds = state.selectedDnsRecordIds.filter((id) =>
      visibleRecordIds.has(id)
    );
    renderApp();

    const input = document.querySelector("#dns-record-search");
    input?.focus();
    input?.setSelectionRange(query.length, query.length);
  }

  async function deleteSelectedDnsRecords() {
    if (!state.selectedZone?.id || state.selectedDnsRecordIds.length === 0) {
      return;
    }

    const recordIds = [...new Set(state.selectedDnsRecordIds)];
    const confirmed = window.confirm(`确定删除选中的 ${recordIds.length} 条 DNS 记录吗？`);

    if (!confirmed) {
      return;
    }

    await runDnsBulk("delete", recordIds);
  }

  return {
    retryDnsBulk,
    closeDnsBulkForm,
    deleteDnsRecord,
    deleteSelectedDnsRecords,
    editDnsRecord,
    loadDnsRecords,
    openCreateDnsForm,
    openDnsBulkForm,
    resetDnsForm: resetDnsFormAction,
    saveDnsRecord,
    searchDnsRecords,
    syncDnsFormType,
    submitDnsBulk,
    toggleAllDnsRecords,
    toggleDnsRecordSelection,
  };
}
