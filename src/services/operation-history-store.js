const fields = [
  ["id", "id"], ["action", "action"], ["method", "method"], ["module", "module"],
  ["path", "path"], ["resource", "resource"], ["status", "status"],
  ["statusCode", "status_code"], ["durationMs", "duration_ms"], ["createdAt", "created_at"],
  ["accountId", "account_id"], ["accountName", "account_name"],
  ["zoneId", "zone_id"], ["zoneName", "zone_name"], ["error", "error"],
];

function decode(row) {
  const entry = Object.fromEntries(fields.map(([name, column]) => [name, row[column]]));
  if (row.summary) entry.summary = JSON.parse(row.summary);
  return entry;
}

// Contains only normalized audit metadata, independent of account deletion or session state.
export class OperationHistoryStore {
  constructor({ database }) {
    this.database = database;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS operation_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        action TEXT NOT NULL,
        method TEXT NOT NULL,
        module TEXT NOT NULL,
        path TEXT NOT NULL,
        resource TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed', 'unknown')),
        status_code INTEGER NOT NULL,
        duration_ms REAL NOT NULL,
        created_at TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_name TEXT NOT NULL,
        zone_id TEXT NOT NULL,
        zone_name TEXT NOT NULL,
        error TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS operation_history_account_time ON operation_history(account_id, created_at);
      CREATE INDEX IF NOT EXISTS operation_history_zone_time ON operation_history(account_id, zone_id, created_at);
      CREATE INDEX IF NOT EXISTS operation_history_time ON operation_history(created_at);
    `);
  }

  record(entry, maxEntries) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const columns = fields.map(([, column]) => column).concat("summary");
      this.database.prepare(`INSERT INTO operation_history (${columns.join(", ")})
        VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...fields.map(([name]) => entry[name]), entry.summary ? JSON.stringify(entry.summary) : "");
      this.prune(maxEntries);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  prune(maxEntries) {
    this.database.prepare(`DELETE FROM operation_history WHERE sequence IN (
      SELECT sequence FROM operation_history ORDER BY sequence DESC LIMIT -1 OFFSET ?
    )`).run(maxEntries);
  }

  all() {
    return this.database.prepare("SELECT * FROM operation_history ORDER BY sequence DESC").all().map(decode);
  }

  clear() {
    return { deleted: this.database.prepare("DELETE FROM operation_history").run().changes };
  }
}
