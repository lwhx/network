import { randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { HttpError } from "../lib/http-error.js";

const finalStatuses = new Set(["completed", "rolled_back", "manual_resolved"]);
const timestamp = () => new Date().toISOString();
const leaseDurationMs = 90_000;
function namespace() {
  try { return readlinkSync("/proc/self/ns/pid"); } catch { return null; }
}
function processIdentity(pid = "self") {
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const procPid = stat.split(" ")[0];
    return `${boot}:${procPid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
  } catch { return null; }
}
function live(lock) {
  if (!lock?.owner) return false;
  const parsed = JSON.parse(lock.owner);
  const ownIdentity = processIdentity();
  if (parsed.identity && ownIdentity && parsed.identity.split(":")[0] !== ownIdentity.split(":")[0]) return false;
  if (parsed.namespace && parsed.namespace !== namespace()) return Number(lock.lease_until) > Date.now();
  const identity = parsed.identity ? processIdentity(parsed.identity.split(":")[1]) : null;
  if (identity) return identity === parsed.identity;
  try { process.kill(parsed.pid, 0); return true; }
  catch (error) { return error.code === "ESRCH" ? false : Number(lock.lease_until) > Date.now(); }
}
const busy = () => new HttpError(409, "该账号的区域有进行中或尚未核查的加速任务，请先检查任务记录");

export class SpeedTaskStore {
  constructor({ store }) {
    this.store = store;
    this.database = store.database;
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.owner = JSON.stringify({ pid: process.pid, identity: processIdentity(), namespace: namespace(), instance: randomUUID() });
    this.database.exec(`CREATE TABLE IF NOT EXISTS speed_tasks (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, zone_id TEXT NOT NULL,
      zone_name TEXT NOT NULL, access_domain TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
      error TEXT NOT NULL DEFAULT '', snapshot TEXT NOT NULL,
      inspected_revision TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS speed_tasks_scope ON speed_tasks(account_id, zone_id);
    CREATE TABLE IF NOT EXISTS speed_task_locks (
      account_id TEXT NOT NULL, zone_id TEXT NOT NULL, task_id TEXT,
      owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account_id, zone_id)
    );`);
    if (!this.database.prepare("PRAGMA table_info(speed_tasks)").all().some(column => column.name === "revision")) {
      this.database.exec("ALTER TABLE speed_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    }
    if (!this.database.prepare("PRAGMA table_info(speed_task_locks)").all().some(column => column.name === "lease_until")) {
      this.database.exec("ALTER TABLE speed_task_locks ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0");
    }
    this.heartbeat = setInterval(() => {
      try {
        this.database.prepare("UPDATE speed_task_locks SET lease_until=? WHERE owner=?").run(Date.now() + leaseDurationMs, this.owner);
      } catch { clearInterval(this.heartbeat); }
    }, 15_000);
    this.heartbeat.unref();
  }

  atomic(callback) {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = callback(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  acquireScope(accountId, zoneId) {
    this.atomic(() => {
      if (!this.database.prepare("SELECT 1 FROM cloudflare_accounts WHERE id=?").get(accountId)) {
        throw new HttpError(404, "Cloudflare 账号已不存在，请刷新账号列表。");
      }
      const lock = this.database.prepare("SELECT * FROM speed_task_locks WHERE account_id=? AND zone_id=?").get(accountId, zoneId);
      if (lock && (lock.task_id || live(lock))) throw busy();
      this.database.prepare("INSERT OR REPLACE INTO speed_task_locks VALUES (?, ?, NULL, ?, ?)").run(accountId, zoneId, this.owner, Date.now() + leaseDurationMs);
    });
  }

  releaseScope(accountId, zoneId) {
    this.database.prepare("DELETE FROM speed_task_locks WHERE account_id=? AND zone_id=? AND owner=? AND task_id IS NULL").run(accountId, zoneId, this.owner);
  }

  begin(accountId, config) {
    const id = randomUUID(), at = timestamp();
    this.atomic(() => {
      if (!this.database.prepare("SELECT 1 FROM cloudflare_accounts WHERE id=?").get(accountId)) {
        throw new HttpError(404, "Cloudflare 账号已不存在，请刷新账号列表。");
      }
      const lock = this.database.prepare("SELECT * FROM speed_task_locks WHERE account_id=? AND zone_id=? AND owner=? AND task_id IS NULL").get(accountId, config.zoneId, this.owner);
      if (!lock) throw busy();
      this.database.prepare("INSERT INTO speed_tasks (id,account_id,zone_id,zone_name,access_domain,status,created_at,updated_at,snapshot) VALUES (?,?,?,?,?,'running',?,?,?)")
        .run(id, accountId, config.zoneId, config.zoneName, config.accessDomain, at, at, this.store.secretBox.encrypt(JSON.stringify({ steps: [], audit: [] })));
      this.database.prepare("UPDATE speed_task_locks SET task_id=? WHERE account_id=? AND zone_id=? AND owner=?").run(id, accountId, config.zoneId, this.owner);
    });
    return id;
  }

  row(id, accountId) {
    const row = this.database.prepare("SELECT * FROM speed_tasks WHERE id=? AND account_id=?").get(id, accountId);
    if (!row) throw new HttpError(404, "未找到该账号的加速任务");
    return row;
  }

  load(id, accountId) {
    const row = this.row(id, accountId);
    return { row, snapshot: JSON.parse(this.store.secretBox.decrypt(row.snapshot)) };
  }

  assertOwned(row) {
    const lock = this.database.prepare("SELECT * FROM speed_task_locks WHERE account_id=? AND zone_id=?").get(row.account_id, row.zone_id);
    if (!lock || lock.task_id !== row.id || lock.owner !== this.owner) throw busy();
  }

  save(id, accountId, snapshot, { status, error = "" } = {}) {
    this.atomic(() => {
      const row = this.row(id, accountId); this.assertOwned(row);
      const next = status || row.status, at = timestamp();
      this.database.prepare("UPDATE speed_tasks SET snapshot=?,status=?,error=?,updated_at=?,finished_at=?,inspected_revision='',revision=revision+1 WHERE id=?")
        .run(this.store.secretBox.encrypt(JSON.stringify(snapshot)), next, error, at, finalStatuses.has(next) ? at : null, id);
      if (finalStatuses.has(next)) this.database.prepare("DELETE FROM speed_task_locks WHERE task_id=? AND owner=?").run(id, this.owner);
      else if (next === "manual_needed") this.database.prepare("UPDATE speed_task_locks SET owner=NULL WHERE task_id=? AND owner=?").run(id, this.owner);
    });
  }

  claim(id, accountId, { resolving = false } = {}) {
    this.atomic(() => {
      const row = this.row(id, accountId);
      if (finalStatuses.has(row.status)) throw new HttpError(409, "该任务已结束，无需恢复");
      const lock = this.database.prepare("SELECT * FROM speed_task_locks WHERE task_id=?").get(id);
      if (!lock || live(lock)) throw busy();
      if (resolving && row.inspected_revision !== String(row.revision)) throw new HttpError(409, "请先检查此任务的当前配置，再确认人工处理完成");
      this.database.prepare("UPDATE speed_task_locks SET owner=?,lease_until=? WHERE task_id=?").run(this.owner, Date.now() + leaseDurationMs, id);
      if (!resolving) this.database.prepare("UPDATE speed_tasks SET status='recovering',updated_at=?,inspected_revision='',revision=revision+1 WHERE id=?").run(timestamp(), id);
    });
    return this.load(id, accountId).snapshot;
  }

  markInspected(id, accountId, revision) {
    this.database.prepare("UPDATE speed_tasks SET inspected_revision=? WHERE id=? AND account_id=? AND revision=?").run(String(revision), id, accountId, revision);
  }

  publicTask(row, snapshot) {
    const lock = this.database.prepare("SELECT * FROM speed_task_locks WHERE task_id=?").get(row.id);
    const active = Boolean(lock && live(lock));
    return { id: row.id, accountId: row.account_id, zoneId: row.zone_id,
      zoneName: row.zone_name, accessDomain: row.access_domain,
      status: !finalStatuses.has(row.status) && !active ? "manual_needed" : row.status,
      kind: snapshot.kind || "deployment",
      createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at || "",
      error: row.error, recoverable: !finalStatuses.has(row.status) && !active,
      steps: snapshot.steps.map(step => ({ resource: step.label, type: step.type, status: step.status })),
      recoveryAudit: snapshot.audit };
  }

  get(id, accountId) { const { row, snapshot } = this.load(id, accountId); return this.publicTask(row, snapshot); }
  list(accountId, { zoneId } = {}) {
    const rows = zoneId
      ? this.database.prepare("SELECT * FROM speed_tasks WHERE account_id=? AND zone_id=? ORDER BY created_at DESC, rowid DESC").all(accountId, zoneId)
      : this.database.prepare("SELECT * FROM speed_tasks WHERE account_id=? ORDER BY created_at DESC, rowid DESC").all(accountId);
    return rows.map(row => this.publicTask(row, JSON.parse(this.store.secretBox.decrypt(row.snapshot))));
  }
  hasUnresolvedAccountTasks(accountId) {
    if (this.database.prepare("SELECT 1 FROM speed_tasks WHERE account_id=? AND status NOT IN ('completed','rolled_back','manual_resolved') LIMIT 1").get(accountId)) return true;
    return this.database.prepare("SELECT * FROM speed_task_locks WHERE account_id=?").all(accountId)
      .some((lock) => Boolean(lock.task_id) || live(lock));
  }
}
