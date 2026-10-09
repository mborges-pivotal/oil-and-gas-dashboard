/**
 * /api/leaderboard?period=1w — public portfolios ranked by return.
 *
 * A portfolio is on it when its owner marks it Public (settings.portfolios[].
 * visibility). Only the rank, movement, portfolio name, the owner's display
 * name and initials, and the return % leave the server — never amounts,
 * holdings or email addresses.
 *
 * Periods: today, 1w, 1m, 3m, ytd, 1y, all.
 * Returns are on stocks and funds (cash holdings and option contracts are
 * left out, so they compare fairly), rebuilt from each portfolio's trades and
 * Yahoo daily closes:
 *  - all: gain over cost of what's held (as on the portfolio cards);
 *  - the others: Modified Dietz — (end value − start value − net money in) ÷
 *    (start value + money in weighted by how long it was there), so buying
 *    more doesn't count as a return. Positions entered as totals (no
 *    trades) count as held throughout.
 * Movement: the standings for the same period as of the previous trading
 * day vs. now (▲ up, ▼ down, new = not ranked then).
 * Cached for 5 minutes per period; cleared when any settings are saved.
 */
const db = require('./db');
const { dispatch, requireUser, sendJson, HttpError } = require('./auth');

const PERIODS = {
  today: { label: 'Today', days: 'prev' },
  '1w': { label: '1W', days: 7 },
  '1m': { label: '1M', months: 1 },
  '3m': { label: '3M', months: 3 },
  ytd: { label: 'YTD', ytd: true },
  '1y': { label: '1Y', months: 12 },
  all: { label: 'All-Time', all: true },
};
const HISTORY_TTL_MS = 60 * 60 * 1000;
const BOARD_TTL_MS = 5 * 60 * 1000;
const DAY = 86400000;

// ── Price history (daily closes, 10 years), cached ──
const histories = new Map(); // symbol → { at, promise }
function dayIn(tz, sec) {
  try { return new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: tz || 'America/New_York' }); } catch { return new Date(sec * 1000).toISOString().slice(0, 10); }
}
async function fetchHistory(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=10y`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const r = (await res.json())?.chart?.result?.[0];
  if (!r?.timestamp) throw new Error(`No history for ${symbol}`);
  const tz = r.meta?.exchangeTimezoneName;
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  const dates = [], close = [];
  r.timestamp.forEach((t, i) => { if (closes[i] != null) { dates.push(dayIn(tz, t)); close.push(closes[i]); } });
  return { dates, close, cash: r.meta?.instrumentType === 'MONEYMARKET' };
}
function getHistory(symbol) {
  const hit = histories.get(symbol);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.promise;
  const promise = fetchHistory(symbol).catch(e => { histories.delete(symbol); throw e; });
  histories.set(symbol, { at: Date.now(), promise });
  return promise;
}
function priceOn(h, day) { // last close on or before `day`
  let lo = 0, hi = h.dates.length - 1, found = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (h.dates[m] <= day) { found = m; lo = m + 1; } else hi = m - 1; }
  return found === -1 ? null : h.close[found];
}

// ── A portfolio's stocks and funds as dated quantity changes ──
const OUT = t => t.type === 'sell' || t.type === 'transfer-out';
function holdingsOf(pf) {
  const out = [];
  const add = (symbol, pos, closed) => {
    if (!pos || pos.category === 'cash') return;
    const txs = [...(pos.transactions ?? [])].filter(t => t?.date).sort((a, b) => a.date.localeCompare(b.date));
    const net = txs.reduce((q, t) => q + (OUT(t) ? -t.quantity : t.quantity), 0);
    const qty = closed ? 0 : Number(pos.quantity) || 0;
    const replay = txs.length > 0 && Math.abs(net - qty) < 1e-6;
    if (!replay && !(qty > 0)) return;
    out.push({ symbol, replay, txs, quantity: qty, avgCost: Number(pos.avgCost) || 0 });
  };
  for (const [sym, pos] of Object.entries(pf.portfolio ?? {})) if (pos?.quantity > 0) add(sym, pos, false);
  for (const c of pf.closedPositions ?? []) if (c.kind !== 'option') add(c.symbol, { transactions: c.transactions, quantity: 0 }, true);
  return out;
}
// Quantity and cost basis (average cost) held at the end of `day`.
function stateOn(h, day) {
  if (!h.replay) return { qty: h.quantity, cost: h.quantity * h.avgCost };
  let qty = 0, cost = 0;
  for (const t of h.txs) {
    if (t.date > day) break;
    if (OUT(t)) { const avg = qty > 0 ? cost / qty : 0; qty -= t.quantity; cost -= t.quantity * avg; }
    else { qty += t.quantity; cost += t.quantity * t.price; }
  }
  return { qty, cost };
}

/** Return (%) of a portfolio for a period ending on `end`, or null when there's nothing to measure. */
function periodReturn(holdings, hist, period, end, prevOf) {
  if (period.all) {
    let value = 0, cost = 0;
    for (const h of holdings) {
      const s = stateOn(h, end);
      const px = priceOn(hist[h.symbol], end);
      if (s.qty > 1e-9 && px != null) { value += s.qty * px; cost += s.cost; }
    }
    return cost > 0 ? ((value - cost) / cost) * 100 : null;
  }
  let start;
  if (period.days === 'prev') start = prevOf(end);
  else if (period.ytd) start = `${Number(end.slice(0, 4)) - 1}-12-31`;
  else if (period.days) start = new Date(Date.parse(end + 'T12:00:00Z') - period.days * DAY).toISOString().slice(0, 10);
  else { const d = new Date(end + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - period.months); start = d.toISOString().slice(0, 10); }
  if (!start || start >= end) return null;
  const span = (Date.parse(end) - Date.parse(start)) / DAY;
  let vStart = 0, vEnd = 0, flows = 0, weighted = 0;
  for (const h of holdings) {
    const hh = hist[h.symbol];
    const ps = priceOn(hh, start), pe = priceOn(hh, end);
    const s0 = stateOn(h, start), s1 = stateOn(h, end);
    if (ps != null) vStart += s0.qty * ps;
    if (pe != null) vEnd += s1.qty * pe;
    if (!h.replay) continue;
    for (const t of h.txs) {
      if (t.date <= start || t.date > end) continue;
      const px = t.type === 'transfer-in' || t.type === 'transfer-out' ? (priceOn(hh, t.date) ?? t.price) : t.price;
      const amount = (OUT(t) ? -1 : 1) * t.quantity * px;
      flows += amount;
      weighted += amount * ((Date.parse(end) - Date.parse(t.date)) / DAY) / span;
    }
  }
  const base = vStart + weighted;
  if (!(base > 0)) return null;
  return ((vEnd - vStart - flows) / base) * 100;
}

const COLORS = 8;
const initialsOf = name => (name.match(/\b\p{L}/gu) ?? []).slice(0, 2).join('').toUpperCase() || '?';

// ── The board ──
const boards = new Map(); // period → { at, promise }
async function buildBoard(periodId) {
  const period = PERIODS[periodId];
  const entries = [];
  for (const { userId, settings } of db.profilesWithSettings()) {
    for (const pf of settings?.portfolios ?? []) {
      if (pf?.visibility !== 'public') continue;
      const holdings = holdingsOf(pf);
      if (holdings.length) entries.push({ userId, pf, holdings });
    }
  }
  const symbols = [...new Set(entries.flatMap(e => e.holdings.map(h => h.symbol)))];
  const hist = {};
  await Promise.all(symbols.map(async s => { try { hist[s] = await getHistory(s); } catch { /* skipped below */ } }));
  // Money-market funds count as cash; holdings without history can't be priced.
  for (const e of entries) e.holdings = e.holdings.filter(h => hist[h.symbol] && !hist[h.symbol].cash);
  // The trading calendar: every date any holding traded.
  const calendar = [...new Set(Object.values(hist).flatMap(h => h.dates))].sort();
  const end = calendar.at(-1);
  const prevEnd = calendar.at(-2);
  const prevOf = day => calendar.filter(d => d < day).at(-1) ?? null; // the trading day before
  const rank = endDay => {
    const scored = entries.map(e => ({ e, r: e.holdings.length ? periodReturn(e.holdings, hist, period, endDay, prevOf) : null }))
      .filter(x => x.r != null && Number.isFinite(x.r))
      .sort((a, b) => b.r - a.r);
    return new Map(scored.map((x, i) => [x.e, { rank: i + 1, r: x.r }]));
  };
  const now = end ? rank(end) : new Map();
  const before = prevEnd ? rank(prevEnd) : new Map();
  const names = new Map();
  const rows = [...now.entries()].map(([e, { rank: r, r: ret }]) => {
    if (!names.has(e.userId)) names.set(e.userId, (db.getProfile(e.userId)?.displayName || '').trim() || 'Anonymous investor');
    const display = names.get(e.userId);
    const prev = before.get(e);
    return {
      rank: r,
      movement: prev ? prev.rank - r : null, // + up, − down, null = new
      portfolio: e.pf.name,
      owner: display,
      initials: initialsOf(display),
      color: (e.userId * 5) % COLORS + 1,
      returnPct: Math.round(ret * 100) / 100,
      userId: e.userId,
    };
  }).sort((a, b) => a.rank - b.rank);
  return { period: periodId, asOf: end ?? null, previous: prevEnd ?? null, rows };
}

function getBoard(periodId) {
  const hit = boards.get(periodId);
  if (hit && Date.now() - hit.at < BOARD_TTL_MS) return hit.promise;
  const promise = buildBoard(periodId).catch(e => { boards.delete(periodId); throw e; });
  boards.set(periodId, { at: Date.now(), promise });
  return promise;
}
/** Someone saved settings (e.g. made a portfolio public): rebuild on the next request. */
function clearLeaderboardCache() { boards.clear(); }

async function handleLeaderboardApi(req, res, reqUrl) {
  const path = reqUrl.pathname.replace(/\/+$/, '');
  if (path !== '/api/leaderboard' || req.method !== 'GET') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  await dispatch(req, res, reqUrl, async () => {
    const me = requireUser(req);
    const periodId = reqUrl.searchParams.get('period') || 'all';
    if (!PERIODS[periodId]) throw new HttpError(400, `period must be one of: ${Object.keys(PERIODS).join(', ')}`);
    const board = await getBoard(periodId);
    // Whose rows are yours is the only per-user thing — and no user IDs go out.
    sendJson(res, 200, { ...board, rows: board.rows.map(({ userId, ...r }) => ({ ...r, mine: userId === me })) });
  });
}

module.exports = { handleLeaderboardApi, clearLeaderboardCache, periodReturn, holdingsOf, PERIODS };
