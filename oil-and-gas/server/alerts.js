/**
 * /api/alerts routes: a signed-in user's stock alerts, plus the check that
 * evaluates them. There's no background job — the dashboard calls
 * POST /api/alerts/check each time it refreshes quotes, and the server then
 * fetches fresh quotes for every stock the user has an active alert on
 * (not just the ones on screen), fires what's met, and records the events
 * that Inbox → Alerts lists.
 *
 *   GET    /api/alerts                 → { alerts }
 *   POST   /api/alerts                 { symbol, kind, params, repeat?, note? } → 201 { alert, events }
 *   PUT    /api/alerts/:id             { kind?, params?, repeat?, note?, active? } → { alert, events }
 *     (a new, edited or re-armed alert is evaluated right away; `events` holds it if it fired)
 *   DELETE /api/alerts/:id             → 204
 *   POST   /api/alerts/check           → { events: [newly fired], alerts }
 *   GET    /api/alerts/events          → { events }   (latest 200)
 *   POST   /api/alerts/events/read     { ids? } (omit for all) → 204
 *
 * Kinds and params:
 *   price     { direction: above|below, target, basis: fixed|percent, percent?, basePrice? }
 *   daily     { direction: up|down|either, percent }          vs. previous close
 *   position  { direction: gain|loss, percent }               vs. the Portfolio avg cost
 *   high52    { within }   price at/within X% of the 52-week high (0 = at it)
 *   low52     { within }   … of the 52-week low
 *   volume    { multiple } today's volume ≥ N × 3-month average
 * repeat: 'once' (switches off after firing) | 'daily' (at most once per trading day).
 */

const db = require('./db');
const { dispatch, requireUser, readJsonBody, sendJson, HttpError } = require('./auth');

const MAX_ALERTS = 200;
const MAX_NOTE_LENGTH = 500;
const TICKER_RE = /^\^?[A-Z0-9][A-Z0-9.\-=]{0,19}$/; // matches server/watchlists.js
const KINDS = ['price', 'daily', 'position', 'high52', 'low52', 'volume'];
const NEAR_TOLERANCE_PCT = 0.1;   // "at" a 52-week high/low allows 0.1%
const CHECK_MIN_INTERVAL_MS = 15 * 1000;
const QUOTE_TTL_MS = 60 * 1000;
const AVG_VOLUME_DAYS = 63;       // ~3 months of sessions

// ── Validation ────────────────────────────────────────────────────────────
function num(value, field, { min = -Infinity, max = Infinity, gt = null } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, `${field} must be a number`);
  if (gt !== null && !(n > gt)) throw new HttpError(400, `${field} must be greater than ${gt}`);
  if (n < min || n > max) throw new HttpError(400, `${field} must be between ${min} and ${max}`);
  return n;
}

function oneOf(value, field, options) {
  if (!options.includes(value)) throw new HttpError(400, `${field} must be one of: ${options.join(', ')}`);
  return value;
}

function validateParams(kind, p) {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new HttpError(400, 'params must be an object');
  switch (kind) {
    case 'price': {
      const basis = oneOf(p.basis ?? 'fixed', 'basis', ['fixed', 'percent']);
      const out = { direction: oneOf(p.direction, 'direction', ['above', 'below']), basis };
      if (basis === 'percent') {
        out.percent = num(p.percent, 'Percent', { min: -99, max: 1000 });
        out.basePrice = num(p.basePrice, 'Base price', { gt: 0 });
        out.target = Math.round(out.basePrice * (1 + out.percent / 100) * 10000) / 10000;
      } else {
        out.target = num(p.target, 'Target price', { gt: 0 });
      }
      return out;
    }
    case 'daily':
      return { direction: oneOf(p.direction, 'direction', ['up', 'down', 'either']), percent: num(p.percent, 'Percent', { gt: 0, max: 100 }) };
    case 'position':
      return { direction: oneOf(p.direction, 'direction', ['gain', 'loss']), percent: num(p.percent, 'Percent', { gt: 0, max: 1000 }) };
    case 'high52':
    case 'low52':
      return { within: num(p.within ?? 0, 'Within', { min: 0, max: 50 }) };
    case 'volume':
      return { multiple: num(p.multiple, 'Multiple', { gt: 1, max: 100 }) };
    default:
      throw new HttpError(400, 'Unknown alert type');
  }
}

function validateNote(note) {
  if (note == null) return '';
  if (typeof note !== 'string') throw new HttpError(400, 'Note must be text');
  const t = note.trim();
  if (t.length > MAX_NOTE_LENGTH) throw new HttpError(400, `Note must be at most ${MAX_NOTE_LENGTH} characters`);
  return t;
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, 'Alert not found');
  return id;
}

// ── Text ──────────────────────────────────────────────────────────────────
const usd = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
const pct = v => `${Math.round(v * 100) / 100}%`;

/** One-line description of an alert's condition (event bodies; the UI has its own). */
function describe(a) {
  const p = a.params;
  switch (a.kind) {
    case 'price':
      return `Price ${p.direction} ${usd(p.target)}` + (p.basis === 'percent' ? ` (${p.percent >= 0 ? '+' : ''}${pct(p.percent)} from ${usd(p.basePrice)})` : '');
    case 'daily':
      return `${p.direction === 'either' ? 'Moves' : p.direction === 'up' ? 'Up' : 'Down'} ${pct(p.percent)} or more in a day`;
    case 'position':
      return `Position ${p.direction === 'gain' ? 'gain' : 'loss'} of ${pct(p.percent)} vs. average cost`;
    case 'high52':
      return p.within ? `Within ${pct(p.within)} of the 52-week high` : 'New 52-week high';
    case 'low52':
      return p.within ? `Within ${pct(p.within)} of the 52-week low` : 'New 52-week low';
    case 'volume':
      return `Volume ${p.multiple}× the 3-month average`;
    default:
      return a.kind;
  }
}

// ── Quotes (server-side, cached briefly) ──────────────────────────────────
const quoteCache = new Map(); // symbol → { at, promise }

function dayIn(tz, epochSeconds) {
  try {
    return new Date(epochSeconds * 1000).toLocaleDateString('en-CA', { timeZone: tz || 'America/New_York' });
  } catch {
    return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
  }
}

async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const result = (await res.json())?.chart?.result?.[0];
  if (!result?.meta) throw new Error(`No quote for ${symbol}`);
  const m = result.meta;
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const closes = q.close ?? [];
  const volumes = q.volume ?? [];
  const tz = m.exchangeTimezoneName;
  const day = dayIn(tz, m.regularMarketTime ?? Math.floor(Date.now() / 1000));
  // Is the last daily bar today's (still forming) session?
  const lastIsToday = ts.length > 0 && dayIn(tz, ts[ts.length - 1]) === day;
  const completed = lastIsToday ? ts.length - 1 : ts.length;
  let prevClose = m.previousClose ?? null;
  for (let i = completed - 1; prevClose == null && i >= 0; i--) if (closes[i] != null) prevClose = closes[i];
  const pastVolumes = volumes.slice(0, completed).filter(v => v != null).slice(-AVG_VOLUME_DAYS);
  return {
    symbol,
    day,
    price: m.regularMarketPrice ?? null,
    prevClose,
    high52: m.fiftyTwoWeekHigh ?? null,
    low52: m.fiftyTwoWeekLow ?? null,
    volume: m.regularMarketVolume ?? null,
    avgVolume: pastVolumes.length ? pastVolumes.reduce((a, b) => a + b, 0) / pastVolumes.length : null,
  };
}

function getQuote(symbol) {
  const hit = quoteCache.get(symbol);
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.promise;
  const promise = fetchQuote(symbol).catch(err => {
    quoteCache.delete(symbol);
    throw err;
  });
  quoteCache.set(symbol, { at: Date.now(), promise });
  return promise;
}

setInterval(() => {
  const now = Date.now();
  for (const [sym, hit] of quoteCache) if (now - hit.at > QUOTE_TTL_MS) quoteCache.delete(sym);
}, 5 * 60 * 1000).unref();

// ── Evaluation ────────────────────────────────────────────────────────────
/** null if not met (or not evaluable), else { title, detail }. */
function evaluate(alert, q, avgCost) {
  const p = alert.params;
  const price = q.price;
  if (price == null) return null;
  const s = alert.symbol;
  switch (alert.kind) {
    case 'price':
      if (p.direction === 'above' ? price >= p.target : price <= p.target) {
        return { title: `${s} ${p.direction === 'above' ? 'rose above' : 'fell below'} ${usd(p.target)}`, detail: `Price ${usd(price)}` };
      }
      return null;
    case 'daily': {
      if (!q.prevClose) return null;
      const change = ((price - q.prevClose) / q.prevClose) * 100;
      const hit = p.direction === 'up' ? change >= p.percent
        : p.direction === 'down' ? change <= -p.percent
        : Math.abs(change) >= p.percent;
      return hit ? { title: `${s} ${change >= 0 ? 'up' : 'down'} ${pct(Math.abs(change))} today`, detail: `Price ${usd(price)}, previous close ${usd(q.prevClose)}` } : null;
    }
    case 'position': {
      if (!(avgCost > 0)) return null;
      const g = ((price - avgCost) / avgCost) * 100;
      const hit = p.direction === 'gain' ? g >= p.percent : g <= -p.percent;
      return hit ? { title: `${s} position ${g >= 0 ? 'up' : 'down'} ${pct(Math.abs(g))}`, detail: `Price ${usd(price)} vs. your average cost ${usd(avgCost)}` } : null;
    }
    case 'high52': {
      if (!q.high52) return null;
      const hit = price >= q.high52 * (1 - Math.max(p.within, NEAR_TOLERANCE_PCT) / 100);
      return hit ? { title: p.within ? `${s} within ${pct(p.within)} of its 52-week high` : `${s} at a 52-week high`, detail: `Price ${usd(price)}, 52-week high ${usd(q.high52)}` } : null;
    }
    case 'low52': {
      if (!q.low52) return null;
      const hit = price <= q.low52 * (1 + Math.max(p.within, NEAR_TOLERANCE_PCT) / 100);
      return hit ? { title: p.within ? `${s} within ${pct(p.within)} of its 52-week low` : `${s} at a 52-week low`, detail: `Price ${usd(price)}, 52-week low ${usd(q.low52)}` } : null;
    }
    case 'volume': {
      if (!q.volume || !q.avgVolume) return null;
      const x = q.volume / q.avgVolume;
      return x >= p.multiple ? { title: `${s} volume ${Math.round(x * 10) / 10}× its 3-month average`, detail: `Volume ${Math.round(q.volume).toLocaleString('en-US')}` } : null;
    }
    default:
      return null;
  }
}

const lastCheck = new Map(); // userId → ms

// Evaluate the user's active alerts — or just `onlyIds` (a newly saved alert).
async function runCheck(userId, onlyIds = null) {
  const active = db.listActiveAlerts(userId).filter(a => !onlyIds || onlyIds.includes(a.id));
  if (!active.length) return [];
  const symbols = [...new Set(active.map(a => a.symbol))];
  const quotes = new Map();
  await Promise.all(symbols.map(async sym => {
    try { quotes.set(sym, await getQuote(sym)); } catch { /* skip this symbol this round */ }
  }));
  const portfolio = db.getProfile(userId)?.settings?.portfolio ?? {};
  const events = [];
  for (const alert of active) {
    const q = quotes.get(alert.symbol);
    if (!q) continue;
    if (alert.repeat === 'daily' && alert.lastTriggeredDay === q.day) continue;
    const hit = evaluate(alert, q, Number(portfolio[alert.symbol]?.avgCost));
    if (!hit) continue;
    const body = [hit.detail, `Alert: ${describe(alert)}${alert.repeat === 'daily' ? ' (daily)' : ''}`, alert.note].filter(Boolean).join('\n');
    events.push(db.fireAlert(userId, alert, q.day, hit.title, body));
  }
  return events;
}

// ── Routes ────────────────────────────────────────────────────────────────
function list(req, res) {
  sendJson(res, 200, { alerts: db.listAlerts(requireUser(req)) });
}

async function create(req, res) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
  if (!TICKER_RE.test(symbol)) throw new HttpError(400, 'Invalid ticker symbol');
  const kind = oneOf(body.kind, 'kind', KINDS);
  const alert = {
    symbol,
    kind,
    params: validateParams(kind, body.params),
    repeat: oneOf(body.repeat ?? 'once', 'repeat', ['once', 'daily']),
    note: validateNote(body.note),
  };
  if (db.countAlerts(userId) >= MAX_ALERTS) throw new HttpError(400, `You can have at most ${MAX_ALERTS} alerts`);
  const id = db.createAlert(userId, alert);
  const events = await runCheck(userId, [id]); // already met? fire now, not on the next refresh
  sendJson(res, 201, { alert: db.getAlert(userId, id), events });
}

async function update(req, res, id) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  const existing = db.getAlert(userId, id);
  if (!existing) throw new HttpError(404, 'Alert not found');
  if ('kind' in body && !('params' in body)) throw new HttpError(400, 'Changing the alert type needs its params too');
  const kind = 'kind' in body ? oneOf(body.kind, 'kind', KINDS) : existing.kind;
  const next = {
    kind,
    params: 'params' in body ? validateParams(kind, body.params) : existing.params,
    repeat: 'repeat' in body ? oneOf(body.repeat, 'repeat', ['once', 'daily']) : existing.repeat,
    note: 'note' in body ? validateNote(body.note) : existing.note,
    active: 'active' in body ? !!body.active : existing.active,
  };
  db.updateAlert(userId, id, next);
  const events = next.active ? await runCheck(userId, [id]) : [];
  sendJson(res, 200, { alert: db.getAlert(userId, id), events });
}

function remove(req, res, id) {
  if (!db.deleteAlert(requireUser(req), id)) throw new HttpError(404, 'Alert not found');
  sendJson(res, 204);
}

async function check(req, res) {
  const userId = requireUser(req);
  // The dashboard calls this on every quote refresh (possibly from several
  // tabs) — a short per-user cooldown keeps that from hammering Yahoo.
  const now = Date.now();
  let events = [];
  if (now - (lastCheck.get(userId) ?? 0) >= CHECK_MIN_INTERVAL_MS) {
    lastCheck.set(userId, now);
    events = await runCheck(userId);
  }
  sendJson(res, 200, { events, alerts: db.listAlerts(userId) });
}

function listEvents(req, res) {
  sendJson(res, 200, { events: db.listAlertEvents(requireUser(req)) });
}

async function markRead(req, res) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  let ids = null;
  if (body.ids !== undefined) {
    if (!Array.isArray(body.ids) || body.ids.length > 500) throw new HttpError(400, 'ids must be an array');
    ids = body.ids.map(i => parseId(i));
  }
  db.markAlertEventsRead(userId, ids);
  sendJson(res, 204);
}

async function handleAlertsApi(req, res, reqUrl) {
  const path = reqUrl.pathname.replace(/\/+$/, '');
  let handler = null;
  let m;
  if (path === '/api/alerts') {
    if (req.method === 'GET') handler = list;
    else if (req.method === 'POST') handler = create;
  } else if (path === '/api/alerts/check') {
    if (req.method === 'POST') handler = check;
  } else if (path === '/api/alerts/events') {
    if (req.method === 'GET') handler = listEvents;
  } else if (path === '/api/alerts/events/read') {
    if (req.method === 'POST') handler = markRead;
  } else if ((m = path.match(/^\/api\/alerts\/([^/]+)$/))) {
    if (req.method === 'PUT') handler = (rq, rs) => update(rq, rs, parseId(m[1]));
    else if (req.method === 'DELETE') handler = (rq, rs) => remove(rq, rs, parseId(m[1]));
  }
  if (!handler) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  await dispatch(req, res, reqUrl, handler);
}

module.exports = { handleAlertsApi, evaluate, describe };
