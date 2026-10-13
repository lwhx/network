import { isDeepStrictEqual } from "node:util";
import { HttpError } from "../../lib/http-error.js";

function containsFields(actual, expected) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    return isDeepStrictEqual(actual, expected);
  }
  return actual && typeof actual === "object" && Object.entries(expected)
    .every(([key, value]) => containsFields(actual[key], value));
}

// Compensating operations, including writes whose response was lost. Snapshots
// contain only editable fields; asynchronous certificate/status changes are ignored.
export class SpeedDeployTransaction {
  constructor() {
    this.operations = [];
  }

  same(resource, left, right) {
    return (!left || !right)
      ? left === right
      : (!right.id || left.id === right.id)
        && isDeepStrictEqual(resource.fields(left), resource.fields(right));
  }

  matchesApplied(resource, current) {
    // Creation responses may contain defaults absent from the request. Once a
    // write is confirmed, retain its full editable state and ID for rollback.
    return !resource.before && !resource.confirmed
      ? Boolean(current?.id || resource.expected.origin)
        && containsFields(current, resource.creationBody)
        && (!resource.creationGuard || resource.creationGuard(current))
      : this.same(resource, current, resource.expected);
  }

  async apply(resource) {
    const current = await resource.read();
    if (!this.same(resource, current, resource.before)) {
      throw new HttpError(409, `${resource.label}在检查后发生变化，请刷新后重试`);
    }
    if (this.same(resource, current, resource.expected)) return current;

    // Register before sending, since Cloudflare can apply a request even when
    // the caller receives a timeout, disconnect or error response.
    this.operations.push(resource);
    const response = await resource.write();
    if (!resource.before && this.matchesApplied(resource, response?.result)) {
      resource.expected = response.result;
      resource.confirmed = true;
    }
    const applied = await resource.read();
    if (!this.matchesApplied(resource, applied)) {
      throw new HttpError(502, `${resource.label}写入结果无法确认`);
    }
    resource.expected = applied;
    resource.confirmed = true;
    return applied;
  }

  async fail(error) {
    if (!this.operations.length) throw error;
    const steps = [];
    for (const resource of [...this.operations].reverse()) {
      try {
        const current = await resource.read();
        if (this.same(resource, current, resource.before)) {
          if (error.remoteOutcomeUnknown && resource === this.operations.at(-1)) {
            throw new Error("写入请求结果未确认，远端仍可能执行，请稍后人工核查");
          }
          steps.push({ resource: resource.label, status: "unchanged" });
          continue;
        }
        if (!this.matchesApplied(resource, current)) {
          throw new Error("配置已被其他操作修改，未覆盖；请人工核查");
        }
        let restoreError;
        try {
          await resource.restore(current);
        } catch (error) {
          restoreError = error;
        }
        if (!this.same(resource, await resource.read(), resource.before)) {
          throw restoreError || new Error("恢复结果无法确认，请人工核查");
        }
        steps.push({ resource: resource.label, status: "restored" });
      } catch (rollbackError) {
        steps.push({ resource: resource.label, status: "failed", message: rollbackError.message });
      }
    }
    const failed = steps.filter((step) => step.status === "failed");
    const summary = failed.length
      ? `恢复未完成：${failed.map((step) => `${step.resource}（${step.message}）`).join("；")}`
      : "已恢复本次操作涉及的配置";
    const failure = new HttpError(error.statusCode || 502, `${error.message}；${summary}`);
    failure.rollback = { status: failed.length ? "incomplete" : "complete", steps };
    throw failure;
  }
}
