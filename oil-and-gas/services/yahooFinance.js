/**
 * Yahoo Finance unofficial API service.
 * Uses query1.finance.yahoo.com with a local CORS relay as fallback
 * (see local-proxy.js — run `node local-proxy.js` alongside `serve`).
 * Public CORS-bypass proxies (allorigins.win, etc.) were dropped: they're
 * unreliable as a service and are often blocked outright by corporate
 * network filtering as "proxy/anonymizer" sites.
 */

const BASE = 'https://query1.finance.yahoo.com';
const DEFAULT_LOCAL_PROXY_URL = '/proxy?url=';

// Configurable from Settings — see configureYahooFinance().
let corsProxyMode = 'local';               // 'local' | 'none'
let localProxyUrl = DEFAULT_LOCAL_PROXY_URL;

/**
 * Configure how this service works around Yahoo Finance's missing CORS
 * headers. Called from app.js whenever config loads or is saved.
 *
 * @param {object} settings
 * @param {'local'|'none'} [settings.corsProxy]  'local' routes through the
 *   local relay (local-proxy.js); 'none' makes direct-only requests, which
 *   will fail in-browser unless something else on the network allows it.
 * @param {string} [settings.localProxyUrl]  Relay endpoint, including the
 *   trailing `?url=` (or `&url=`) query prefix.
 */
export function configureYahooFinance(settings = {}) {
  corsProxyMode = settings.corsProxy === 'none' ? 'none' : 'local';
  localProxyUrl = settings.localProxyUrl || DEFAULT_LOCAL_PROXY_URL;
}

async function fetchWithFallback(url) {
  // Cache-bust: some proxies/shared caches (notably Safari's cross-origin
  // subresource cache) can still return a 304 here despite no-store, and
  // response.ok is false for 304 — a unique query param prevents any
  // intermediary from matching this request to a prior response.
  const bustedUrl = url + (url.includes('?') ? '&' : '?') + '_ts=' + Date.now();
  try {
    const res = await fetch(bustedUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (directErr) {
    if (corsProxyMode === 'none') {
      throw new Error(`Direct request failed and no proxy is configured (Settings → Yahoo Finance CORS Proxy): ${directErr.message}`);
    }
    // CORS fallback via the local relay (node local-proxy.js)
    const proxied = localProxyUrl + encodeURIComponent(bustedUrl);
    const res = await fetch(proxied, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Local proxy HTTP ${res.status}. Is 'node local-proxy.js' running?`);
    return res.json();
  }
}

/**
 * Fetch current quote data for a single symbol.
 * Returns: { symbol, shortName, price, previousClose, change, pctChange, volume, currency }
 */
export async function fetchQuote(symbol) {
  const url = `${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
  const data = await fetchWithFallback(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${symbol}`);
  const meta = result.meta;
  const price = meta.regularMarketPrice ?? meta.chartPreviousClose;
  const prev = meta.previousClose ?? meta.chartPreviousClose;
  const change = price - prev;
  const pctChange = prev !== 0 ? (change / prev) * 100 : 0;
  return {
    symbol,
    shortName: meta.shortName ?? symbol,
    price,
    previousClose: prev,
    change,
    pctChange,
    volume: meta.regularMarketVolume ?? null,
    currency: meta.currency ?? 'USD',
  };
}

/**
 * Fetch historical close prices for a sparkline (last N days).
 * Returns: { symbol, timestamps: number[], closes: number[] }
 */
export async function fetchChart(symbol, range = '1mo', interval = '1d') {
  const url = `${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const data = await fetchWithFallback(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${symbol}`);
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  return { symbol, timestamps, closes };
}
