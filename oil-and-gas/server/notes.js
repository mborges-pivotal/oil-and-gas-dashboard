/**
 * /api/notes routes: a signed-in user's notes, each with labels — either a
 * news article saved from a stock's News tab, or a manual note written on
 * the Notes tab (stocks, optional link, text). DB-only; every route
 * requires a session and is scoped to that user.
 *
 *   GET    /api/notes                 → { notes: [...], labels: [...] }
 *   POST   /api/notes                 news:   { symbol, title, link, source?, pubDate?, image?, note?, labels? }
 *                                     manual: { kind: 'manual', note, symbols?, link?, labels? }
 *                                     → 201 { note, labels }   (labels: the user's full label list)
 *   PUT    /api/notes/:id             { note?, labels? } — plus { symbols?, link? } for manual notes
 *                                     → { note, labels }
 *   DELETE /api/notes/:id             → 204
 *   DELETE /api/notes/labels/:id      → 204   (removes the label from every note)
 *
 * `labels` in a request is an array of label *names*; missing ones are
 * created. Same CSRF stance as server/auth.js: mutating routes need JSON.
 */

const db = require('./db');
const { dispatch, requireUser, readJsonBody, sendJson, HttpError } = require('./auth');

const MAX_NOTES = 2000;
const MAX_LABELS = 100;
const MAX_LABELS_PER_NOTE = 10;
const MAX_LABEL_LENGTH = 30;
const MAX_NOTE_LENGTH = 5000;
const MAX_SYMBOLS_PER_NOTE = 10;
const TICKER_RE = /^\^?[A-Z0-9][A-Z0-9.\-=]{0,19}$/; // matches server/watchlists.js

function text(value, field, max, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new HttpError(400, `${field} is required`);
  if (trimmed.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return trimmed;
}

function httpUrl(value, field, { required = false } = {}) {
  const s = text(value, field, 2000, { required });
  if (!s) return '';
  let url;
  try { url = new URL(s); } catch { throw new HttpError(400, `${field} must be a URL`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, `${field} must be an http(s) URL`);
  return url.href;
}

function validateLabels(labels) {
  if (labels === undefined) return undefined;
  if (!Array.isArray(labels)) throw new HttpError(400, 'labels must be an array of names');
  const clean = [];
  for (const l of labels) {
    const name = text(l, 'Label', MAX_LABEL_LENGTH, { required: true }).replace(/\s+/g, ' ');
    if (!clean.some(c => c.toLowerCase() === name.toLowerCase())) clean.push(name);
  }
  if (clean.length > MAX_LABELS_PER_NOTE) throw new HttpError(400, `A note can have at most ${MAX_LABELS_PER_NOTE} labels`);
  return clean;
}

// New label names in `names` mustn't push the user past MAX_LABELS.
function checkLabelBudget(userId, names) {
  const fresh = names.filter(n => !db.labelExists(userId, n)).length;
  if (fresh && db.countLabels(userId) + fresh > MAX_LABELS) {
    throw new HttpError(400, `You can have at most ${MAX_LABELS} labels`);
  }
}

function validateSymbol(value) {
  const sym = text(value, 'Symbol', 20, { required: true }).toUpperCase();
  if (!TICKER_RE.test(sym)) throw new HttpError(400, `Invalid ticker symbol: ${sym.slice(0, 24)}`);
  return sym;
}

function validateSymbols(symbols) {
  if (symbols === undefined) return undefined;
  if (!Array.isArray(symbols)) throw new HttpError(400, 'symbols must be an array of tickers');
  const clean = [...new Set(symbols.map(validateSymbol))];
  if (clean.length > MAX_SYMBOLS_PER_NOTE) throw new HttpError(400, `A note can have at most ${MAX_SYMBOLS_PER_NOTE} stocks`);
  return clean;
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, 'Note not found');
  return id;
}

function list(req, res) {
  const userId = requireUser(req);
  sendJson(res, 200, { notes: db.listNotes(userId), labels: db.listLabels(userId) });
}

async function create(req, res) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  let n;
  if (body.kind === 'manual') {
    n = {
      kind: 'manual',
      symbols: validateSymbols(body.symbols) ?? [],
      title: '',
      link: httpUrl(body.link, 'Link'),
      source: '', pubDate: '', image: '',
      note: text(body.note, 'Note', MAX_NOTE_LENGTH, { required: true }),
    };
  } else {
    const symbol = validateSymbol(body.symbol);
    n = {
      kind: 'news',
      symbols: [symbol],
      title: text(body.title, 'Title', 500, { required: true }),
      link: httpUrl(body.link, 'Link', { required: true }),
      source: text(body.source, 'Source', 200),
      pubDate: text(body.pubDate, 'Publish date', 40),
      image: httpUrl(body.image, 'Image'),
      note: text(body.note, 'Note', MAX_NOTE_LENGTH),
    };
    if (db.findNewsNote(userId, symbol, n.link)) {
      throw new HttpError(409, `This article is already in your notes for ${symbol}`);
    }
  }
  const labels = validateLabels(body.labels) ?? [];
  if (db.countNotes(userId) >= MAX_NOTES) throw new HttpError(400, `You can have at most ${MAX_NOTES} notes`);
  checkLabelBudget(userId, labels);
  const id = db.createNote(userId, n, labels);
  sendJson(res, 201, { note: db.getNote(userId, id), labels: db.listLabels(userId) });
}

async function update(req, res, id) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  const existing = db.getNote(userId, id);
  if (!existing) throw new HttpError(404, 'Note not found');
  const manual = existing.kind === 'manual';
  if (!manual && ('symbols' in body || 'link' in body)) {
    throw new HttpError(400, "A saved article's stock and link can't be changed");
  }
  // Validate everything before writing anything.
  const note = 'note' in body
    ? text(body.note, 'Note', MAX_NOTE_LENGTH, { required: manual }) // a manual note is its text
    : undefined;
  const labels = validateLabels(body.labels);
  const symbols = validateSymbols(body.symbols);
  const link = 'link' in body ? httpUrl(body.link, 'Link') : undefined;
  if (labels) checkLabelBudget(userId, labels);
  db.updateNote(userId, id, { note, labels, symbols, link });
  sendJson(res, 200, { note: db.getNote(userId, id), labels: db.listLabels(userId) });
}

function remove(req, res, id) {
  if (!db.deleteNote(requireUser(req), id)) throw new HttpError(404, 'Note not found');
  sendJson(res, 204);
}

function removeLabel(req, res, id) {
  if (!db.deleteLabel(requireUser(req), id)) throw new HttpError(404, 'Label not found');
  sendJson(res, 204);
}

async function handleNotesApi(req, res, reqUrl) {
  const path = reqUrl.pathname.replace(/\/+$/, '');
  let handler = null;
  let m;
  if (path === '/api/notes') {
    if (req.method === 'GET') handler = list;
    else if (req.method === 'POST') handler = create;
  } else if ((m = path.match(/^\/api\/notes\/labels\/([^/]+)$/))) {
    if (req.method === 'DELETE') handler = (rq, rs) => removeLabel(rq, rs, parseId(m[1]));
  } else if ((m = path.match(/^\/api\/notes\/([^/]+)$/))) {
    if (req.method === 'PUT') handler = (rq, rs) => update(rq, rs, parseId(m[1]));
    else if (req.method === 'DELETE') handler = (rq, rs) => remove(rq, rs, parseId(m[1]));
  }
  if (!handler) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  await dispatch(req, res, reqUrl, handler);
}

module.exports = { handleNotesApi };
