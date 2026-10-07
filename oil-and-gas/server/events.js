/**
 * /api/events routes: upcoming company events that a browser can't fetch
 * itself. Earnings dates come from Nasdaq.com's (unofficial) analyst API,
 * which is fed by Zacks Investment Research and rejects browser CORS requests.
 *
 *   GET /api/events/earnings?symbols=XOM,CVX
 *     → { earnings: { XOM: { date, time, confirmed, quarter, epsForecast, epsLastYear } | null } }
 *       date: 'YYYY-MM-DD'; time: 'before-open' | 'after-close' | null;
 *       confirmed: false when Zacks estimates the date from past reporting dates.
 *
 * Results are cached for 6 hours per symbol (also used by the earnings alert
 * in server/alerts.js). Public — it only relays public data.
 */
const { dispatch, sendJson, HttpError } = require('./auth');

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SYMBOLS = 60;
const CONCURRENCY = 5;
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

const cache = new Map(); // symbol → { at, promise }

const pad = n => String(n).padStart(2, '0');

/** Nasdaq's analyst text → structured earnings info (null when there's no date). */
function parseEarnings(data) {
  if (!data) return null;
  const text = (data.reportText || '').replace(/\s+/g, ' ');
  let date = null;
  const m = text.match(/report earnings on (\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) date = `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  if (!date) {
    const a = (data.announcement || '').match(/:\s*([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/);
    if (a && MONTHS[a[1]]) date = `${a[3]}-${pad(MONTHS[a[1]])}-${pad(a[2])}`;
  }
  if (!date) return null;
  const money = re => {
    const x = text.match(re);
    return x ? Number(x[1]) : null;
  };
  return {
    date,
    time: /before market open/i.test(text) ? 'before-open' : /after market close/i.test(text) ? 'after-close' : null,
    // "is expected* to report … before market open" = announced; "is estimated
    // to report … derived from an algorithm" = Zacks' estimate.
    confirmed: !/estimated to report|derived from an algorithm/i.test(text),
    quarter: text.match(/fiscal Quarter ending ([A-Z][a-z]{2} \d{4})/)?.[1] ?? null,
    epsForecast: money(/consensus EPS forecast for the quarter is \$(-?\d+(?:\.\d+)?)/),
    epsLastYear: money(/reported EPS for the same quarter last year was \$(-?\d+(?:\.\d+)?)/),
  };
}

async function fetchEarnings(symbol) {
  // Nasdaq writes share classes with a dot-less slash form; plain tickers are the common case.
  const res = await fetch(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(symbol.replace('-', '.'))}/earnings-date`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Nasdaq HTTP ${res.status}`);
  const j = await res.json();
  return parseEarnings(j?.data);
}

/** Cached earnings info for one symbol (null if none / unknown symbol). */
function getEarnings(symbol) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = fetchEarnings(symbol).catch(err => {
    cache.delete(symbol); // retry next time
    throw err;
  });
  cache.set(symbol, { at: Date.now(), promise });
  return promise;
}

setInterval(() => {
  const now = Date.now();
  for (const [sym, hit] of cache) if (now - hit.at > TTL_MS) cache.delete(sym);
}, 60 * 60 * 1000).unref();

async function earnings(req, res, reqUrl) {
  const symbols = [...new Set((reqUrl.searchParams.get('symbols') || '').split(',')
    .map(s => s.trim().toUpperCase()).filter(Boolean))];
  if (!symbols.length) throw new HttpError(400, 'symbols is required');
  if (symbols.length > MAX_SYMBOLS) throw new HttpError(400, `At most ${MAX_SYMBOLS} symbols`);
  const out = {};
  const queue = symbols.filter(s => {
    if (TICKER_RE.test(s)) return true;
    out[s] = null; // indexes (^GSPC), futures (CL=F), funds without earnings…
    return false;
  });
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const s = queue.shift();
      try { out[s] = await getEarnings(s); } catch { out[s] = null; }
    }
  }));
  sendJson(res, 200, { earnings: out });
}

async function handleEventsApi(req, res, reqUrl) {
  const path = reqUrl.pathname.replace(/\/+$/, '');
  if (path === '/api/events/earnings' && req.method === 'GET') {
    await dispatch(req, res, reqUrl, (rq, rs) => earnings(rq, rs, reqUrl));
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

module.exports = { handleEventsApi, getEarnings, parseEarnings };
