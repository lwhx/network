import { state } from "./state.js";

const channels = new Map();
const pendingReads = new Map();

export function captureRequestContext(readContext = () => "", { navigation = true } = {}) {
  const revision = state.dataRevision;
  const navigationRevision = state.navigationRevision;
  const accountId = state.activeCloudflareAccountId;
  const context = readContext();
  return { isCurrent: () => state.dataRevision === revision &&
    (!navigation || state.navigationRevision === navigationRevision) &&
    state.activeCloudflareAccountId === accountId && readContext() === context };
}

export function beginScopedRequest(channel, readContext = () => "", options = {}) {
  channels.get(channel)?.abort();
  const controller = new AbortController();
  channels.set(channel, controller);
  const context = captureRequestContext(readContext, options);
  return { signal: controller.signal,
    isCurrent: () => channels.get(channel) === controller && !controller.signal.aborted && context.isCurrent() };
}

export function trackReadRequest(controller, url = "") {
  pendingReads.set(controller, url);
  return () => pendingReads.delete(controller);
}

export function invalidateReadRequests({ navigationOnly = false } = {}) {
  if (!navigationOnly) state.dataRevision += 1;
  state.navigationRevision += 1;
  for (const [controller, url] of pendingReads) {
    if (navigationOnly && url === "/api/zones") continue;
    controller.abort(); pendingReads.delete(controller);
  }
  for (const [channel, controller] of channels) {
    if (navigationOnly && channel === "zones") continue;
    controller.abort(); channels.delete(channel);
  }
}
