import { createServer } from "node:http";

export function createSpeedCloudflareMock({
  dnsRecords = [], customHostnames = [], fallbackOrigin = null,
  ssl = "flexible", zoneName = "alpha.example", intercept = async () => false,
} = {}) {
  const zoneId = "a".repeat(32);
  const requests = [];
  const state = structuredClone({ dnsRecords, customHostnames, fallbackOrigin, ssl, zoneName });
  let nextId = 100;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const call = { method: request.method, path: url.pathname,
      query: Object.fromEntries(url.searchParams), body };
    requests.push(call);
    const send = (result, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: status < 400, result,
        errors: status >= 400 ? [{ message: "injected Cloudflare failure" }] : [],
        result_info: { page: 1, total_pages: 1 } }));
    };
    const apply = () => {
      const base = `/zones/${zoneId}`;
      if (call.path === base && call.method === "GET") return { id: zoneId, name: state.zoneName };
      if (call.path === `${base}/settings/ssl`) {
        if (call.method === "PATCH") state.ssl = body.value;
        return { id: "ssl", value: state.ssl, editable: true };
      }
      if (call.path === `${base}/custom_hostnames/fallback_origin`) {
        if (call.method === "PUT") state.fallbackOrigin = { origin: body.origin, status: "active" };
        if (call.method === "DELETE") state.fallbackOrigin = null;
        return state.fallbackOrigin;
      }
      if (call.path === `${base}/dns_records`) {
        if (call.method === "GET") return state.dnsRecords;
        const record = { id: String(nextId++).padStart(32, "0"), comment: "", tags: [], ...body };
        state.dnsRecords.push(record);
        return record;
      }
      if (call.path.startsWith(`${base}/dns_records/`)) {
        const id = call.path.split("/").at(-1);
        const record = state.dnsRecords.find((item) => item.id === id);
        if (call.method === "DELETE") {
          state.dnsRecords = state.dnsRecords.filter((item) => item.id !== id);
          return { id };
        }
        if (call.method === "PATCH") Object.assign(record, body);
        return record;
      }
      if (call.path === `${base}/custom_hostnames`) {
        if (call.method === "GET") return state.customHostnames.filter((item) =>
          !call.query.hostname || item.hostname === call.query.hostname);
        const hostname = { id: `hostname-${nextId++}`, status: "pending", ...body };
        state.customHostnames.push(hostname);
        return hostname;
      }
      if (call.path.startsWith(`${base}/custom_hostnames/`)) {
        const id = call.path.split("/").at(-1);
        const hostname = state.customHostnames.find((item) => item.id === id);
        if (call.method === "DELETE") {
          state.customHostnames = state.customHostnames.filter((item) => item.id !== id);
          return { id };
        }
        if (call.method === "PATCH") Object.assign(hostname, body);
        return hostname;
      }
      throw new Error(`Unexpected mock endpoint: ${call.method} ${call.path}`);
    };
    try {
      if (await intercept({ call, state, apply, send, disconnect: () => response.destroy() })) return;
      send(apply());
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, errors: [{ message: error.message }] }));
    }
  });
  return { requests, server, state };
}
