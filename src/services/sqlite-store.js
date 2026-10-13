import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";

import { SecretBox } from "./secret-box.js";

function nowIso() {
  return new Date().toISOString();
}

function normalizeString(value) {
  return String(value || "").trim();
}

function rowToPanelUser(row, secretBox) {
  if (!row) {
    return null;
  }

  return {
    createdAt: row.created_at,
    id: row.id,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    totpSecret: secretBox.decrypt(row.totp_secret),
    totpEnabled: Boolean(row.totp_secret),
    authRevision: row.auth_revision,
    updatedAt: row.updated_at,
    username: row.username,
  };
}

function rowToCloudflareAccount(row, secretBox) {
  if (!row) {
    return null;
  }

  return {
    createdAt: row.created_at,
    email: row.email,
    globalApiKey: secretBox.decrypt(row.global_api_key),
    id: row.id,
    name: row.name || row.email,
    source: "sqlite",
    updatedAt: row.updated_at,
  };
}

export class SqliteStore {
  constructor({ databasePath, secretKey = "" }) {
    this.databasePath = databasePath;
    this.secretBox = new SecretBox({
      keyMaterial: secretKey || `sqlite-store:${databasePath}`,
    });
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS panel_user (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        totp_secret TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cloudflare_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        global_api_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const columns = this.database.prepare("PRAGMA table_info(panel_user)").all();
    if (!columns.some((column) => column.name === "auth_revision")) {
      this.database.exec("ALTER TABLE panel_user ADD COLUMN auth_revision TEXT NOT NULL DEFAULT ''");
    }
    this.database.prepare("UPDATE panel_user SET auth_revision = ? WHERE auth_revision = ''")
      .run(randomBytes(24).toString("base64url"));
    this.database.exec(`CREATE TABLE IF NOT EXISTS panel_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES panel_user(id) ON DELETE CASCADE,
      auth_revision TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      account_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS panel_sessions_expiry ON panel_sessions(expires_at_ms);`);
  }

  hasPanelUser() {
    const row = this.database.prepare("SELECT 1 AS exists_flag FROM panel_user WHERE id = 1").get();
    return Boolean(row?.exists_flag);
  }

  getPanelUser() {
    const row = this.database.prepare("SELECT * FROM panel_user WHERE id = 1").get();
    return rowToPanelUser(row, this.secretBox);
  }

  createPanelUser({ passwordHash, passwordSalt, totpSecret, username }) {
    const createdAt = nowIso();

    this.database
      .prepare(
        `INSERT INTO panel_user (
          id,
          username,
          password_hash,
          password_salt,
          totp_secret,
          auth_revision,
          created_at,
          updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        normalizeString(username),
        passwordHash,
        passwordSalt,
        totpSecret ? this.secretBox.encrypt(normalizeString(totpSecret)) : "",
        randomBytes(24).toString("base64url"),
        createdAt,
        createdAt
      );

    return this.getPanelUser();
  }

  getAuthRevision() {
    return this.database.prepare("SELECT auth_revision FROM panel_user WHERE id = 1").get()?.auth_revision || "";
  }

  updateTwoFactor(secret) {
    const revision = randomBytes(24).toString("base64url");
    this.database.prepare("UPDATE panel_user SET totp_secret = ?, auth_revision = ?, updated_at = ? WHERE id = 1")
      .run(secret ? this.secretBox.encrypt(secret) : "", revision, nowIso());
    this.database.exec("DELETE FROM panel_sessions");
    return revision;
  }

  createSession(session) {
    const result = this.database.prepare(`INSERT INTO panel_sessions
      (token_hash, user_id, auth_revision, csrf_token, account_id, created_at_ms, expires_at_ms)
      SELECT ?, id, ?, ?, ?, ?, ? FROM panel_user WHERE id = 1 AND auth_revision = ?`).run(
      createHash("sha256").update(session.id).digest("hex"), session.authRevision,
      session.csrfToken, session.activeCloudflareAccountId, Date.parse(session.createdAt), session.expiresAtMs,
      session.authRevision
    );
    return result.changes > 0;
  }

  updateSession(session, now) {
    const result = this.database.prepare(`UPDATE panel_sessions SET csrf_token = ?, account_id = ?
      WHERE token_hash = ? AND auth_revision = ? AND expires_at_ms > ?
      AND EXISTS (SELECT 1 FROM panel_user WHERE id = 1 AND auth_revision = panel_sessions.auth_revision)`)
      .run(session.csrfToken, session.activeCloudflareAccountId,
        createHash("sha256").update(session.id).digest("hex"), session.authRevision, now);
    return result.changes > 0;
  }

  getSession(id, now) {
    const row = this.database.prepare(`SELECT s.* FROM panel_sessions s
      JOIN panel_user u ON u.id = s.user_id AND u.auth_revision = s.auth_revision
      WHERE s.token_hash = ? AND s.expires_at_ms > ?`)
      .get(createHash("sha256").update(id).digest("hex"), now);
    if (!row) return null;
    return {
      id, authenticated: true, remember: true, authRevision: row.auth_revision,
      activeCloudflareAccountId: row.account_id, csrfToken: row.csrf_token,
      createdAt: new Date(row.created_at_ms).toISOString(),
      expiresAt: new Date(row.expires_at_ms).toISOString(), expiresAtMs: row.expires_at_ms,
      email: "", globalApiKey: "", source: "panel",
    };
  }

  deleteSession(id) {
    this.database.prepare("DELETE FROM panel_sessions WHERE token_hash = ?")
      .run(createHash("sha256").update(id).digest("hex"));
  }

  pruneSessions(now) {
    this.database.prepare("DELETE FROM panel_sessions WHERE expires_at_ms <= ?").run(now);
  }

  hasCloudflareAccounts() {
    const row = this.database
      .prepare("SELECT 1 AS exists_flag FROM cloudflare_accounts LIMIT 1")
      .get();
    return Boolean(row?.exists_flag);
  }

  hasCloudflareAccountEmail(email = "") {
    const normalizedEmail = normalizeString(email).toLowerCase();

    if (!normalizedEmail) {
      return false;
    }

    const row = this.database
      .prepare(
        `SELECT 1 AS exists_flag
         FROM cloudflare_accounts
         WHERE lower(email) = ?
         LIMIT 1`
      )
      .get(normalizedEmail);

    return Boolean(row?.exists_flag);
  }

  listCloudflareAccounts() {
    return this.database
      .prepare(
        `SELECT *
         FROM cloudflare_accounts
         ORDER BY rowid ASC`
      )
      .all()
      .map((row) => rowToCloudflareAccount(row, this.secretBox));
  }

  getCloudflareAccount(accountId = "") {
    const normalizedId = normalizeString(accountId);

    if (normalizedId) {
      return rowToCloudflareAccount(
        this.database.prepare("SELECT * FROM cloudflare_accounts WHERE id = ?").get(normalizedId),
        this.secretBox
      );
    }

    return rowToCloudflareAccount(
      this.database
        .prepare(
          `SELECT *
           FROM cloudflare_accounts
           ORDER BY rowid ASC
          LIMIT 1`
        )
        .get(),
      this.secretBox
    );
  }

  createCloudflareAccount({ email, globalApiKey, name = "" }) {
    const createdAt = nowIso();
    const normalizedEmail = normalizeString(email).toLowerCase();
    const normalizedName = normalizeString(name) || normalizedEmail;
    const id = `cf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    this.database
      .prepare(
        `INSERT INTO cloudflare_accounts (
          id,
          name,
          email,
          global_api_key,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        normalizedName,
        normalizedEmail,
        this.secretBox.encrypt(normalizeString(globalApiKey)),
        createdAt,
        createdAt
      );

    return this.getCloudflareAccount(id);
  }

  createCloudflareAccounts(accounts = []) {
    const created = [];

    for (const account of accounts) {
      created.push(this.createCloudflareAccount(account));
    }

    return created;
  }

  runSetupTransaction(callback) {
    this.database.exec("BEGIN IMMEDIATE");

    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}
