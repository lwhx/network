import { HttpError } from "../../lib/http-error.js";

function paginationNumber(value, minimum, fail) {
  if (value == null) return undefined;
  if ((typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) ||
      !Number.isSafeInteger(Number(value)) || Number(value) < minimum) fail("分页信息异常");
  return Number(value);
}

// Keep list contracts as arrays while making collection completeness explicit:
// a failed later page or invalid continuation never returns an earlier subset.
export async function readCloudflareList({
  client, path, query = {}, perPage = 50, keys = [], identity = item => item.id,
  pagination = "page", errorMessage = "Cloudflare 列表读取失败",
  maxPages = 1000, maxItems = 100_000, maxDurationMs = 60_000,
}) {
  const fail = reason => { throw new HttpError(502, `${errorMessage}：${reason}，请刷新后重试。`); };
  const started = performance.now();
  const checkDeadline = () => { if (performance.now() - started >= maxDurationMs) fail("完整列表读取超时"); };
  const items = new Map(), cursors = new Set();
  let cursor = "", processed = 0;
  let knownSize, knownTotal, knownPages;
  for (let page = 1; page <= maxPages; page += 1) {
    checkDeadline();
    const payload = await client.get(path, { ...query, per_page: perPage,
      ...(pagination === "cursor" ? (cursor ? { cursor } : {}) : { page }) });
    checkDeadline();
    let rows = payload?.result;
    if (!Array.isArray(rows)) rows = keys.map(key => payload?.result?.[key]).find(Array.isArray);
    if (!Array.isArray(rows) || rows.some(item => !item || typeof item !== "object" || Array.isArray(item))) fail("列表格式异常");
    processed += rows.length;
    if (processed > maxItems) fail("记录数量超过读取上限");
    let added = 0;
    for (const item of rows) {
      const id = identity(item);
      if (typeof id !== "string" || !id) fail("列表缺少资源标识");
      if (!items.has(id)) added += 1;
      items.set(id, item);
    }
    const info = payload.result_info ?? {};
    if (typeof info !== "object" || Array.isArray(info)) fail("分页信息异常");
    if (pagination === "cursor") {
      const next = info.cursor ?? payload.result?.cursor ?? info.cursors?.after ?? "";
      if (typeof next !== "string" || Buffer.byteLength(next) > 4096) fail("分页游标异常");
      if (!next) return [...items.values()];
      if (cursors.has(next)) fail("分页游标重复或循环");
      cursors.add(next); cursor = next;
    } else {
      if (page > 1 && rows.length && !added) fail("分页结果重复，无法确认列表完整性");
      const reportedPage = paginationNumber(info.page, 1, fail);
      const reportedSize = paginationNumber(info.per_page, 1, fail);
      const reportedTotal = paginationNumber(info.total_count, 0, fail);
      const reportedPages = paginationNumber(info.total_pages, 0, fail);
      if (reportedPage !== undefined && reportedPage !== page) fail("分页页码未推进");
      const declared = reportedPages === undefined ? undefined : Math.max(1, reportedPages);
      for (const [previous, current] of [[knownSize, reportedSize], [knownTotal, reportedTotal], [knownPages, declared]]) {
        if (previous !== undefined && current !== undefined && previous !== current) fail("读取过程中分页信息发生变化");
      }
      knownSize = reportedSize ?? knownSize;
      knownTotal = reportedTotal ?? knownTotal;
      knownPages = declared ?? knownPages;
      const size = knownSize ?? perPage, total = knownTotal;
      const countPages = total === undefined ? undefined : Math.max(1, Math.ceil(total / size));
      const declaredPages = knownPages;
      if (declaredPages !== undefined && countPages !== undefined && declaredPages !== countPages) fail("分页总数不一致");
      const totalPages = declaredPages ?? countPages;
      if ((totalPages ?? 0) > maxPages || (total ?? 0) > maxItems) fail("分页数量超过读取上限");
      if (!rows.length && totalPages !== undefined && (totalPages > 1 || (total ?? 0) > 0)) fail("分页提前返回空列表");
      if (totalPages !== undefined ? page >= totalPages : rows.length < size) {
        if (total !== undefined && items.size !== total) fail("记录总数与分页不一致");
        return [...items.values()];
      }
      if (!rows.length) fail("分页提前返回空列表");
    }
  }
  fail("分页数量超过读取上限");
}
