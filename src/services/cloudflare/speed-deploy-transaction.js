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
  constructor({ journal = null } = {}) {
    this.operations = [];
    this.journal = journal;
  }

  same(resource, left, right) {
    return (!left || !right)
      ? left === right
      : (!right.id || left.id === right.id)
        && isDeepStrictEqual(resource.fields(left), resource.fields(right));
  }

  matchesApplied(resource, current) {
    if (this.journal && !resource.before && !resource.confirmed) return false;
    // Creation responses may contain defaults absent from the request. Once a
    // write is confirmed, retain its full editable state and ID for rollback.
    return !this.journal && !resource.before && !resource.confirmed
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
    resource.status = "pending";
    this.persist();
    let response;
    try { response = await resource.write(); } catch (error) {
      if (!error.remoteOutcomeUnknown && error.statusCode && error.statusCode < 500) {
        resource.status = "rejected"; this.persist();
      }
      throw error;
    }
    if (!resource.before && response?.result
      && (!this.journal || resource.type === "fallback" || Boolean(response.result.id))
      && containsFields(response.result, resource.creationBody)
      && (!resource.creationGuard || resource.creationGuard(response.result))) {
      resource.expected = response.result;
      resource.confirmed = true;
      resource.status = "confirmed"; this.persist();
    }
    const applied = await resource.read();
    if (!this.matchesApplied(resource, applied)) {
      throw new HttpError(502, `${resource.label}写入结果无法确认`);
    }
    resource.expected = applied;
    resource.confirmed = true;
    resource.status = "confirmed"; this.persist();
    return applied;
  }

  persist() { if (this.journal) this.journal(this.operations); }

  classify(resource, current) {
    if (["restored", "unchanged", "rejected"].includes(resource.status) && this.same(resource, current, resource.before)) return "restored";
    if (["pending", "rollback_pending"].includes(resource.status)) return "unknown_write";
    if (!resource.before && !resource.confirmed) return "unconfirmed_creation";
    if (this.same(resource, current, resource.before)) return "original";
    if (this.matchesApplied(resource, current)) return "applied";
    return "external_change";
  }

  async rollback(error = {}) {
    const steps = [];
    for (const resource of [...this.operations].reverse()) {
      try {
        const current = await resource.read();
        const classification = this.classify(resource, current);
        if (this.journal && ["unknown_write", "unconfirmed_creation", "external_change"].includes(classification)) {
          throw new Error(classification === "unknown_write" ? "写入请求结果未确认，远端仍可能执行，请稍后人工核查"
            : classification === "unconfirmed_creation" ? "创建请求未确认，无法证明资源归属，请人工核查"
              : "配置已被其他操作修改，未覆盖；请人工核查");
        }
        if (this.same(resource, current, resource.before)) {
          if (error.remoteOutcomeUnknown && resource === this.operations.at(-1) && !resource.confirmed) {
            throw new Error("写入请求结果未确认，远端仍可能执行，请稍后人工核查");
          }
          resource.status = "unchanged"; this.persist();
          steps.push({ resource: resource.label, status: "unchanged" });
          continue;
        }
        if (!this.matchesApplied(resource, current)) throw new Error("配置已被其他操作修改，未覆盖；请人工核查");
        resource.status = "rollback_pending"; this.persist();
        let restoreError;
        try { await resource.restore(current); } catch (cause) { restoreError = cause; }
        if (!this.same(resource, await resource.read(), resource.before)) {
          throw restoreError || new Error("恢复结果无法确认，请人工核查");
        }
        if (this.journal && restoreError?.remoteOutcomeUnknown) throw new Error("恢复请求结果未确认，请人工核查");
        resource.status = "restored"; this.persist();
        steps.push({ resource: resource.label, status: "restored" });
      } catch (rollbackError) {
        steps.push({ resource: resource.label, status: "failed", message: this.journal
          ? (["配置已被其他操作修改，未覆盖；请人工核查", "创建请求未确认，无法证明资源归属，请人工核查", "写入请求结果未确认，远端仍可能执行，请稍后人工核查"].includes(rollbackError.message) ? rollbackError.message : "恢复结果无法确认，请人工核查")
          : rollbackError.message });
      }
    }
    return { status: steps.some(step => step.status === "failed") ? "incomplete" : "complete", steps };
  }

  async fail(error) {
    if (!this.operations.length) throw error;
    const rollback = await this.rollback(error);
    const steps = rollback.steps;
    const failed = steps.filter((step) => step.status === "failed");
    const summary = failed.length
      ? `恢复未完成：${failed.map((step) => `${step.resource}（${step.message}）`).join("；")}`
      : "已恢复本次操作涉及的配置";
    const failure = new HttpError(error.statusCode || 502, `${error.message}；${summary}`);
    failure.rollback = { status: failed.length ? "incomplete" : "complete", steps };
    throw failure;
  }
}
