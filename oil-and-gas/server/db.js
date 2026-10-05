/**
 * SQLite persistence for user accounts, sessions, per-user profiles
 * (display name + dashboard settings), and signed-in users' additional
 * stock watchlists, and their saved news notes (with labels).
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

  -- Additional named watchlists (the default one lives in profile settings,
  -- like everything else configurable). tickers is a JSON array of symbols.
  CREATE TABLE IF NOT EXISTS watchlists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    tickers    TEXT NOT NULL DEFAULT '[]',
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, name COLLATE NOCASE)
  );
  CREATE INDEX IF NOT EXISTS watchlists_user_id ON watchlists(user_id);

  -- Notes tab entries. kind 'news': an article saved from a stock's News
  -- tab (title/link/source/pub_date/image are a snapshot — the feed moves
  -- on; the note shouldn't lose its title). kind 'manual': written on the
  -- Notes tab, with an optional link. Stocks live in note_symbols (a news
  -- note has the one it was read under; a manual note any number).
  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL DEFAULT 'news',
    title      TEXT NOT NULL DEFAULT '',
    link       TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT '',
    pub_date   TEXT NOT NULL DEFAULT '',
    image      TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS notes_user_id ON notes(user_id);
  CREATE TABLE IF NOT EXISTS note_symbols (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    symbol  TEXT NOT NULL,
    PRIMARY KEY (note_id, symbol)
  );

  -- A user's labels, reusable across notes (kept even when unused, so the
  -- picker still offers them; deleted explicitly from the Notes tab).
  CREATE TABLE IF NOT EXISTS note_labels (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    UNIQUE (user_id, name COLLATE NOCASE)
  );
  CREATE TABLE IF NOT EXISTS note_label_links (
    note_id  INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES note_labels(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, label_id)
  );
`);

// One-time migration: the first notes table had a single NOT NULL `symbol`
// column and UNIQUE (user_id, symbol, link). Rebuild it in the current shape
// (SQLite can't drop a table constraint in place), moving each symbol into
// note_symbols. Follows SQLite's documented table-rebuild procedure: foreign
// keys off for the swap so dropping the old table doesn't cascade-delete
// note_label_links rows, which keep pointing at "notes" by name.
function migrateNotesTable() {
  const cols = db.prepare('PRAGMA table_info(notes)').all().map(c => c.name);
  if (!cols.includes('symbol')) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE notes_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL DEFAULT 'news',
        title      TEXT NOT NULL DEFAULT '',
        link       TEXT NOT NULL DEFAULT '',
        source     TEXT NOT NULL DEFAULT '',
        pub_date   TEXT NOT NULL DEFAULT '',
        image      TEXT NOT NULL DEFAULT '',
        body       TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO notes_new (id, user_id, kind, title, link, source, pub_date, image, body, created_at, updated_at)
        SELECT id, user_id, 'news', title, link, source, pub_date, image, body, created_at, updated_at FROM notes;
      INSERT OR IGNORE INTO note_symbols (note_id, symbol) SELECT id, symbol FROM notes;
      DROP TABLE notes;
      ALTER TABLE notes_new RENAME TO notes;
      CREATE INDEX IF NOT EXISTS notes_user_id ON notes(user_id);
    `);
    const problems = db.prepare('PRAGMA foreign_key_check').all();
    if (problems.length) throw new Error(`notes migration left ${problems.length} foreign-key problems`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
migrateNotesTable();

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

  // Every watchlist statement is scoped by user_id, so one user can never
  // read or change another's list even with a guessed id.
  watchlists: db.prepare('SELECT * FROM watchlists WHERE user_id = ? ORDER BY position, id'),
  watchlist: db.prepare('SELECT * FROM watchlists WHERE id = ? AND user_id = ?'),
  countWatchlists: db.prepare('SELECT COUNT(*) AS n FROM watchlists WHERE user_id = ?'),
  insertWatchlist: db.prepare(`
    INSERT INTO watchlists (user_id, name, tickers, position)
    VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM watchlists WHERE user_id = ?))
  `),
  renameWatchlist: db.prepare(`UPDATE watchlists SET name = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`),
  setWatchlistTickers: db.prepare(`UPDATE watchlists SET tickers = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`),
  deleteWatchlist: db.prepare('DELETE FROM watchlists WHERE id = ? AND user_id = ?'),

  // Notes — scoped by user_id like the watchlists.
  notes: db.prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC, id DESC'),
  note: db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?'),
  newsNoteFor: db.prepare(`
    SELECT n.id FROM notes n JOIN note_symbols s ON s.note_id = n.id
    WHERE n.user_id = ? AND n.kind = 'news' AND s.symbol = ? AND n.link = ?
  `),
  noteSymbols: db.prepare(`
    SELECT s.note_id, s.symbol FROM note_symbols s JOIN notes n ON n.id = s.note_id
    WHERE n.user_id = ? ORDER BY s.rowid
  `),
  clearNoteSymbols: db.prepare('DELETE FROM note_symbols WHERE note_id = ?'),
  addNoteSymbol: db.prepare('INSERT OR IGNORE INTO note_symbols (note_id, symbol) VALUES (?, ?)'),
  updateNoteLink: db.prepare(`UPDATE notes SET link = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`),
  countNotes: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = ?'),
  insertNote: db.prepare(`
    INSERT INTO notes (user_id, kind, title, link, source, pub_date, image, body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateNoteBody: db.prepare(`UPDATE notes SET body = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`),
  touchNote: db.prepare(`UPDATE notes SET updated_at = datetime('now') WHERE id = ? AND user_id = ?`),
  deleteNote: db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?'),
  labels: db.prepare('SELECT id, name FROM note_labels WHERE user_id = ? ORDER BY name COLLATE NOCASE'),
  labelByName: db.prepare('SELECT id, name FROM note_labels WHERE user_id = ? AND name = ? COLLATE NOCASE'),
  countLabels: db.prepare('SELECT COUNT(*) AS n FROM note_labels WHERE user_id = ?'),
  insertLabel: db.prepare('INSERT INTO note_labels (user_id, name) VALUES (?, ?)'),
  deleteLabel: db.prepare('DELETE FROM note_labels WHERE id = ? AND user_id = ?'),
  noteLabels: db.prepare(`
    SELECT l.id, l.name, nl.note_id FROM note_label_links nl
    JOIN note_labels l ON l.id = nl.label_id
    WHERE l.user_id = ? ORDER BY l.name COLLATE NOCASE
  `),
  clearNoteLabels: db.prepare('DELETE FROM note_label_links WHERE note_id = ?'),
  linkNoteLabel: db.prepare('INSERT OR IGNORE INTO note_label_links (note_id, label_id) VALUES (?, ?)'),
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

function toWatchlist(row) {
  return row && {
    id: row.id,
    name: row.name,
    tickers: JSON.parse(row.tickers),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toNote(row, labelsByNote, symbolsByNote) {
  return row && {
    id: row.id,
    kind: row.kind,
    symbols: symbolsByNote.get(row.id) ?? [],
    title: row.title,
    link: row.link,
    source: row.source,
    pubDate: row.pub_date,
    image: row.image,
    note: row.body,
    labels: labelsByNote.get(row.id) ?? [],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function symbolsByNote(userId) {
  const map = new Map();
  for (const r of stmts.noteSymbols.all(userId)) {
    if (!map.has(r.note_id)) map.set(r.note_id, []);
    map.get(r.note_id).push(r.symbol);
  }
  return map;
}

function setNoteSymbols(noteId, symbols) {
  stmts.clearNoteSymbols.run(noteId);
  for (const sym of symbols) stmts.addNoteSymbol.run(noteId, sym);
}

function labelsByNote(userId) {
  const map = new Map();
  for (const r of stmts.noteLabels.all(userId)) {
    if (!map.has(r.note_id)) map.set(r.note_id, []);
    map.get(r.note_id).push({ id: r.id, name: r.name });
  }
  return map;
}

// Label names → ids, creating missing ones (case-insensitive match).
function ensureLabels(userId, names) {
  return names.map(name => {
    const existing = stmts.labelByName.get(userId, name);
    return existing ? existing.id : Number(stmts.insertLabel.run(userId, name).lastInsertRowid);
  });
}

function setNoteLabels(userId, noteId, names) {
  stmts.clearNoteLabels.run(noteId);
  for (const labelId of ensureLabels(userId, names)) stmts.linkNoteLabel.run(noteId, labelId);
}

function inTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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

  listWatchlists: (userId) => stmts.watchlists.all(userId).map(toWatchlist),
  getWatchlist: (userId, id) => toWatchlist(stmts.watchlist.get(id, userId)),
  countWatchlists: (userId) => stmts.countWatchlists.get(userId).n,
  createWatchlist: (userId, name, tickers) =>
    Number(stmts.insertWatchlist.run(userId, name, JSON.stringify(tickers), userId).lastInsertRowid),
  renameWatchlist: (userId, id, name) => stmts.renameWatchlist.run(name, id, userId).changes > 0,
  setWatchlistTickers: (userId, id, tickers) => stmts.setWatchlistTickers.run(JSON.stringify(tickers), id, userId).changes > 0,
  deleteWatchlist: (userId, id) => stmts.deleteWatchlist.run(id, userId).changes > 0,

  listNotes: (userId) => {
    const labels = labelsByNote(userId);
    const symbols = symbolsByNote(userId);
    return stmts.notes.all(userId).map(r => toNote(r, labels, symbols));
  },
  getNote: (userId, id) => toNote(stmts.note.get(id, userId), labelsByNote(userId), symbolsByNote(userId)),
  /** The news note already saved for this article under this stock, if any. */
  findNewsNote: (userId, symbol, link) => stmts.newsNoteFor.get(userId, symbol, link)?.id ?? null,
  countNotes: (userId) => stmts.countNotes.get(userId).n,
  countLabels: (userId) => stmts.countLabels.get(userId).n,
  labelExists: (userId, name) => !!stmts.labelByName.get(userId, name),
  listLabels: (userId) => stmts.labels.all(userId),
  createNote: (userId, n, labelNames) => inTransaction(() => {
    const id = Number(stmts.insertNote.run(userId, n.kind, n.title, n.link, n.source, n.pubDate, n.image, n.note).lastInsertRowid);
    setNoteSymbols(id, n.symbols);
    setNoteLabels(userId, id, labelNames);
    return id;
  }),
  updateNote: (userId, id, { note, labels, symbols, link }) => inTransaction(() => {
    if (note !== undefined) stmts.updateNoteBody.run(note, id, userId);
    if (link !== undefined) stmts.updateNoteLink.run(link, id, userId);
    if (symbols !== undefined) {
      setNoteSymbols(id, symbols);
      stmts.touchNote.run(id, userId);
    }
    if (labels !== undefined) {
      setNoteLabels(userId, id, labels);
      stmts.touchNote.run(id, userId);
    }
  }),
  deleteNote: (userId, id) => stmts.deleteNote.run(id, userId).changes > 0,
  deleteLabel: (userId, id) => stmts.deleteLabel.run(id, userId).changes > 0,
};
