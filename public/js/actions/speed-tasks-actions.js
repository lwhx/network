import { fetchSpeedTasks, fetchSpeedTask, recoverSpeedTask, resolveSpeedTask } from "../api.js";
import { state } from "../state.js";
import { beginScopedRequest, captureRequestContext } from "../request-scope.js";

export function createSpeedTasksActions({ renderApp }) {
  let detailRevision = 0;
  const context = () => `${state.view}:${state.mainSection}`;
  const detailContext = () => `${context()}:${state.speedTaskDetailId}:${detailRevision}`;

  async function loadSpeedTasks() {
    const request = beginScopedRequest("speed-tasks", context);
    state.speedTasksLoading = true;
    renderApp();
    try {
      const tasks = await fetchSpeedTasks({ signal: request.signal });
      if (request.isCurrent()) state.speedTasks = tasks;
    } catch (error) {
      if (request.isCurrent()) state.speedTasksNotice = error.message;
    } finally {
      if (request.isCurrent()) { state.speedTasksLoading = false; renderApp(); }
    }
  }

  async function ensureSpeedTasksLoaded() {
    if (state.connected && state.sessionAuthenticated && state.activeCloudflareAccount?.id && state.view === "domains" && state.mainSection === "speed") await loadSpeedTasks();
  }

  async function inspectSpeedTask(id) {
    if (state.speedTaskActionId) return;
    detailRevision += 1;
    state.speedTaskDetailId = id;
    state.speedTaskDetail = null;
    state.speedTaskDetailLoading = true;
    state.speedTasksNotice = "";
    const request = beginScopedRequest("speed-task-detail", detailContext);
    renderApp();
    try {
      const task = await fetchSpeedTask(id, { signal: request.signal });
      if (request.isCurrent()) state.speedTaskDetail = task;
    } catch (error) {
      if (request.isCurrent()) state.speedTasksNotice = error.message;
    } finally {
      if (request.isCurrent()) { state.speedTaskDetailLoading = false; renderApp(); }
    }
  }

  function closeSpeedTaskDetail() {
    if (state.speedTaskActionId) return;
    detailRevision += 1;
    state.speedTaskDetailId = "";
    state.speedTaskDetail = null;
    state.speedTaskDetailLoading = false;
    renderApp();
  }

  async function perform(action) {
    const task = state.speedTaskDetail;
    if (!task?.recoverable || state.speedTaskActionId) return;
    const message = action === "recover"
      ? "确定恢复该任务修改前的配置吗？已被其他操作修改或结果未确认的步骤会保留，并提示人工核查。"
      : "请先在 Cloudflare 核查并处理所有未确认步骤。确认人工处理完成后将解除区域锁定；未确认的远端请求仍可能延迟执行。确定已处理完成吗？";
    if (!window.confirm(message)) return;
    const request = captureRequestContext(detailContext);
    state.speedTaskActionId = task.id;
    state.speedTasksNotice = "";
    renderApp();
    try {
      const result = action === "recover" ? await recoverSpeedTask(task.id) : await resolveSpeedTask(task.id);
      if (!request.isCurrent()) return;
      state.speedTaskDetail = result;
      state.speedTasksNotice = result.status === "rolled_back" ? "已确认恢复完成。" : result.status === "manual_resolved"
        ? "已记录人工处理完成，区域锁定已解除。" : "部分步骤仍需人工核查，区域继续保持锁定。";
      try {
        const inspected = await fetchSpeedTask(task.id);
        if (!request.isCurrent()) return;
        state.speedTaskDetail = inspected;
      } catch {
        if (!request.isCurrent()) return;
        state.speedTasksNotice += " 当前配置暂时无法读取，请稍后重新检查。";
      }
      await loadSpeedTasks();
    } catch (error) {
      if (request.isCurrent()) state.speedTasksNotice = `${error.message} 请重新检查任务记录。`;
    } finally {
      if (request.isCurrent()) { state.speedTaskActionId = ""; renderApp(); }
    }
  }

  return { loadSpeedTasks, ensureSpeedTasksLoaded, inspectSpeedTask, closeSpeedTaskDetail,
    recoverSpeedTask: () => perform("recover"), resolveSpeedTask: () => perform("resolve") };
}
