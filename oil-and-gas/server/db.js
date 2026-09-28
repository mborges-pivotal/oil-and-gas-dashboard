/**
 * SQLite persistence for user accounts, sessions, and per-user profiles
 * (display name + dashboard settings).
 *
 * Uses Node's built-in node:sqlite (Node >= 22.13) so the project stays
 * dependency-free — no npm install. The database is a single file:
 * DATABASE_PATH env var, defaulting to ./data/app.db. On Railway the
 * container filesystem is ephemeral, so point DATABASE_PATH at a mounted
 * volume (e.g. /data/app.db) or accounts are lost on every redeploy.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS profiles (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL DEFAULT '',
    -- Dashboard config JSON (same shape as config.json, minus API keys).
    -- NULL until the user first saves, so the client knows to seed it.
    settings     TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- token_hash is SHA-256 of the cookie value, so a leaked DB file
  -- can't be used to hijack live sessions.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
`);

const stmts = {
  insertUser: db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)'),
  insertProfile: db.prepare('INSERT INTO profiles (user_id, display_name) VALUES (?, ?)'),
  userByEmail: db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email, password_hash FROM users WHERE id = ?'),
  updatePassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),

  profile: db.prepare(`
    SELECT u.id, u.email, u.created_at, p.display_name, p.settings, p.updated_at
    FROM users u JOIN profiles p ON p.user_id = u.id
    WHERE u.id = ?
  `),
  updateDisplayName: db.prepare(`UPDATE profiles SET display_name = ?, updated_at = datetime('now') WHERE user_id = ?`),
  updateSettings: db.prepare(`UPDATE profiles SET settings = ?, updated_at = datetime('now') WHERE user_id = ?`),

  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
};

function createUser(email, passwordHash, displayName) {
  db.exec('BEGIN');
  try {
    const { lastInsertRowid } = stmts.insertUser.run(email, passwordHash);
    stmts.insertProfile.run(lastInsertRowid, displayName);
    db.exec('COMMIT');
    return Number(lastInsertRowid);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// SQLite's datetime('now') is UTC as "YYYY-MM-DD HH:MM:SS" (no zone).
function toIso(sqliteDate) {
  return `${sqliteDate.replace(' ', 'T')}Z`;
}

function getProfile(userId) {
  const row = stmts.profile.get(userId);
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    settings: row.settings ? JSON.parse(row.settings) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

module.exports = {
  DB_PATH,
  createUser,
  getProfile,
  findUserByEmail: (email) => stmts.userByEmail.get(email),
  findUserById: (id) => stmts.userById.get(id),
  updatePassword: (id, hash) => stmts.updatePassword.run(hash, id),
  updateDisplayName: (id, name) => stmts.updateDisplayName.run(name, id),
  updateSettings: (id, settings) => stmts.updateSettings.run(JSON.stringify(settings), id),

  createSession: (tokenHash, userId, expiresAt) => stmts.insertSession.run(tokenHash, userId, expiresAt),
  getSessionUserId: (tokenHash) => stmts.sessionUser.get(tokenHash, Date.now())?.user_id ?? null,
  deleteSession: (tokenHash) => stmts.deleteSession.run(tokenHash),
  deleteOtherSessions: (userId, keepTokenHash) => stmts.deleteOtherSessions.run(userId, keepTokenHash),
  deleteExpiredSessions: () => stmts.deleteExpiredSessions.run(Date.now()),
};
