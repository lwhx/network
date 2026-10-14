import { test } from "node:test";
import assert from "node:assert/strict";
import { state, resetSessionState } from "../public/js/state.js";
import { renderSpeedView } from "../public/js/views/speed-view.js";

test("speed page shows recoverable tasks and explains unconfirmed writes", (t) => {
  const before = global.document; const app = { innerHTML: "" };
  global.document = { querySelector: () => app };
  t.after(() => { global.document = before; resetSessionState(); });
  resetSessionState();
  state.speedTasks = [{ id: "task-a", zoneName: "alpha.example", accessDomain: "cdn.alpha.example", status: "manual_needed", recoverable: true, steps: [] }];
  state.speedTaskDetail = { ...state.speedTasks[0], steps: [{ resource: "访问域名 DNS", classification: "unknown_write" }] };
  renderSpeedView();
  assert.match(app.innerHTML, /加速任务记录/);
  assert.match(app.innerHTML, /cdn.alpha.example/);
  assert.match(app.innerHTML, /写入结果未确认/);
  assert.match(app.innerHTML, /speed-task-recover/);
  assert.match(app.innerHTML, /speed-task-resolve/);
});

test("old task inspection cannot replace a newly selected task", async (t) => {
  const previous = global.fetch;
  t.after(() => { global.fetch = previous; resetSessionState(); });
  resetSessionState(); state.mainSection = "speed";
  const module = await import("../public/js/actions/speed-tasks-actions.js").catch(() => null);
  assert.ok(module?.createSpeedTasksActions, "task actions exist");
  const pending = [];
  global.fetch = (url) => new Promise((resolve) => pending.push({ url, resolve }));
  const actions = module.createSpeedTasksActions({ renderApp() {} });
  const old = actions.inspectSpeedTask("task-a");
  const next = actions.inspectSpeedTask("task-b");
  const response = (id) => new Response(JSON.stringify({ task: { id, status: "manual_needed", steps: [] } }), { headers: { "Content-Type": "application/json" } });
  pending[1].resolve(response("task-b")); await next;
  pending[0].resolve(response("task-a")); await old;
  assert.equal(state.speedTaskDetail.id, "task-b");
});
