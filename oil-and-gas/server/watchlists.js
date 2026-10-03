/**
 * /api/watchlists routes: a signed-in user's additional stock watchlists.
 * (The default watchlist is part of the dashboard settings — profile or
 * localStorage — so it works signed out; these extra lists are DB-only and
 * every route requires a session.)
 *
 *   GET    /api/watchlists           → { watchlists: [...] }
 *   POST   /api/watchlists           { name, tickers? }   → 201 { watchlist }
 *   PUT    /api/watchlists/:id       { name?, tickers? }  → { watchlist }
 *   DELETE /api/watchlists/:id       → 204
 *
 * Same CSRF stance as server/auth.js: mutating routes require a JSON body.
 */

const db = require('./db');
const { dispatch, requireUser, readJsonBody, sendJson, HttpError } = require('./auth');

const MAX_WATCHLISTS = 20;
const MAX_TICKERS = 50;
const MAX_NAME_LENGTH = 40;
// Yahoo-style symbols: XOM, BRK-B, XOM.NE, CL=F, ^GSPC
const TICKER_RE = /^\^?[A-Z0-9][A-Z0-9.\-=]{0,19}$/;

function validateName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Watchlist name is required');
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new HttpError(400, `Watchlist name must be at most ${MAX_NAME_LENGTH} characters`);
  }
  // "Default" (the settings-based list) and "Portfolio" (the virtual list of
  // stocks with positions) are built in; a second one would be ambiguous.
  const reserved = ['Default', 'Portfolio'].find(n => n.toLowerCase() === trimmed.toLowerCase());
  if (reserved) throw new HttpError(400, `"${reserved}" is reserved — choose another name`);
  return trimmed;
}

function validateTickers(tickers) {
  if (!Array.isArray(tickers)) throw new HttpError(400, 'tickers must be an array of symbols');
  const clean = [];
  for (const t of tickers) {
    const sym = typeof t === 'string' ? t.trim().toUpperCase() : '';
    if (!TICKER_RE.test(sym)) throw new HttpError(400, `Invalid ticker symbol: ${String(t).slice(0, 24)}`);
    if (!clean.includes(sym)) clean.push(sym);
  }
  if (clean.length > MAX_TICKERS) throw new HttpError(400, `A watchlist can hold at most ${MAX_TICKERS} tickers`);
  return clean;
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, 'Watchlist not found');
  return id;
}

function nameTaken(err) {
  return String(err.message).includes('UNIQUE');
}

function list(req, res) {
  sendJson(res, 200, { watchlists: db.listWatchlists(requireUser(req)) });
}

async function create(req, res) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  const name = validateName(body.name);
  const tickers = body.tickers === undefined ? [] : validateTickers(body.tickers);
  if (db.countWatchlists(userId) >= MAX_WATCHLISTS) {
    throw new HttpError(400, `You can have at most ${MAX_WATCHLISTS} watchlists`);
  }
  let id;
  try {
    id = db.createWatchlist(userId, name, tickers);
  } catch (err) {
    if (nameTaken(err)) throw new HttpError(409, 'You already have a watchlist with that name');
    throw err;
  }
  sendJson(res, 201, { watchlist: db.getWatchlist(userId, id) });
}

async function update(req, res, id) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  if (!db.getWatchlist(userId, id)) throw new HttpError(404, 'Watchlist not found');
  // Validate everything before writing anything, so a bad field can't
  // leave a half-applied update behind.
  const name = 'name' in body ? validateName(body.name) : null;
  const tickers = 'tickers' in body ? validateTickers(body.tickers) : null;
  try {
    if (name !== null) db.renameWatchlist(userId, id, name);
  } catch (err) {
    if (nameTaken(err)) throw new HttpError(409, 'You already have a watchlist with that name');
    throw err;
  }
  if (tickers !== null) db.setWatchlistTickers(userId, id, tickers);
  sendJson(res, 200, { watchlist: db.getWatchlist(userId, id) });
}

function remove(req, res, id) {
  const userId = requireUser(req);
  if (!db.deleteWatchlist(userId, id)) throw new HttpError(404, 'Watchlist not found');
  sendJson(res, 204);
}

async function handleWatchlistsApi(req, res, reqUrl) {
  const match = reqUrl.pathname.match(/^\/api\/watchlists(?:\/([^/]+))?\/?$/);
  let handler = null;
  if (match && !match[1]) {
    if (req.method === 'GET') handler = list;
    else if (req.method === 'POST') handler = create;
  } else if (match) {
    if (req.method === 'PUT') handler = (rq, rs) => update(rq, rs, parseId(match[1]));
    else if (req.method === 'DELETE') handler = (rq, rs) => remove(rq, rs, parseId(match[1]));
  }
  if (!handler) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  await dispatch(req, res, reqUrl, handler);
}

module.exports = { handleWatchlistsApi };
