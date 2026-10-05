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
 * Returns: { symbol, shortName, price, previousClose, change, pctChange, volume, currency,
 *            open, dayHigh, dayLow, fiftyTwoWeekHigh, fiftyTwoWeekLow, instrumentType }
 * instrumentType is Yahoo's EQUITY | ETF | MUTUALFUND | CRYPTOCURRENCY | MONEYMARKET | FUTURE | ...
 */
export async function fetchQuote(symbol) {
  const url = `${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
  const data = await fetchWithFallback(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${symbol}`);
  const meta = result.meta;
  // The chart meta has no regularMarketOpen — take it from the latest daily bar.
  const opens = result.indicators?.quote?.[0]?.open ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const price = meta.regularMarketPrice ?? meta.chartPreviousClose;
  // With range=2d, meta.previousClose is absent and chartPreviousClose is the
  // close *before* the 2-day window (two sessions back), which would make
  // change/pctChange a 2-day move. Yesterday's close is the second-to-last
  // daily bar.
  const prev = meta.previousClose
    ?? (closes.length >= 2 && closes[closes.length - 2] != null ? closes[closes.length - 2] : null)
    ?? meta.chartPreviousClose;
  // Some instruments (e.g. $1-NAV money-market funds) report no previous
  // close — leave the change unknown rather than NaN.
  const hasPrev = prev != null && Number.isFinite(prev);
  const change = hasPrev ? price - prev : null;
  const pctChange = hasPrev && prev !== 0 ? (change / prev) * 100 : (hasPrev ? 0 : null);
  return {
    symbol,
    shortName: meta.shortName ?? symbol,
    price,
    previousClose: prev,
    change,
    pctChange,
    volume: meta.regularMarketVolume ?? null,
    currency: meta.currency ?? 'USD',
    open: opens[opens.length - 1] ?? null,
    dayHigh: meta.regularMarketDayHigh ?? null,
    dayLow: meta.regularMarketDayLow ?? null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
    instrumentType: meta.instrumentType ?? null,
  };
}

const DAY_S = 86400;
const AVG_VOLUME_DAYS = 63; // ~3 months of sessions, matching Yahoo's "Avg. Volume"

// Monthly returns keyed by 'YYYY-MM', from a 1mo-interval chart result.
// The last bar is the current, still-open month, so it's dropped.
function monthlyReturns(result) {
  const ts = result.timestamp ?? [];
  const adj = result.indicators?.adjclose?.[0]?.adjclose ?? result.indicators?.quote?.[0]?.close ?? [];
  const out = {};
  for (let i = 1; i < ts.length - 1; i++) {
    if (adj[i] == null || adj[i - 1] == null) continue;
    out[new Date(ts[i] * 1000).toISOString().slice(0, 7)] = adj[i] / adj[i - 1] - 1;
  }
  return out;
}

// Beta = cov(stock, market) / var(market) over months both series have.
function computeBeta(stock, market) {
  const months = Object.keys(stock).filter(m => m in market);
  if (months.length < 12) return null;
  const s = months.map(m => stock[m]);
  const k = months.map(m => market[m]);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const ms = mean(s), mk = mean(k);
  let cov = 0, varK = 0;
  for (let i = 0; i < months.length; i++) {
    cov += (s[i] - ms) * (k[i] - mk);
    varK += (k[i] - mk) ** 2;
  }
  return varK ? cov / varK : null;
}

function latestReported(timeseries, type) {
  const series = timeseries.find(r => r.meta?.type?.[0] === type)?.[type] ?? [];
  const last = series.filter(Boolean).pop();
  return last ? { value: last.reportedValue?.raw ?? null, asOfDate: last.asOfDate } : null;
}

/**
 * Fetch slower-moving key statistics for the stock detail panel. Each piece
 * is best-effort: a field whose source request fails (or that doesn't apply,
 * e.g. EPS for an ETF) comes back null instead of failing the whole call.
 *
 * Price-dependent ratios (P/E, market cap, yield) are left to the caller to
 * compute against the live quote — the inputs returned here are:
 *   eps                TTM diluted EPS
 *   sharesOutstanding  implied from Yahoo's latest reported market cap ÷ that day's close
 *   dividendsTTM       sum of dividends paid in the last 365 days
 *   avgVolume          mean daily volume over the last ~3 months of completed sessions
 *   beta               5-year monthly beta vs. the S&P 500 (Yahoo's methodology)
 */
export async function fetchKeyStats(symbol) {
  const sym = encodeURIComponent(symbol);
  const now = Math.floor(Date.now() / 1000);
  const [fundamentals, daily, monthly, marketMonthly] = await Promise.allSettled([
    fetchWithFallback(`${BASE}/ws/fundamentals-timeseries/v1/finance/timeseries/${sym}?type=trailingDilutedEPS,trailingMarketCap&period1=${now - 400 * DAY_S}&period2=${now}`),
    fetchWithFallback(`${BASE}/v8/finance/chart/${sym}?interval=1d&range=1y&events=div`),
    fetchWithFallback(`${BASE}/v8/finance/chart/${sym}?interval=1mo&range=5y`),
    fetchWithFallback(`${BASE}/v8/finance/chart/%5EGSPC?interval=1mo&range=5y`),
  ]);
  const value = r => (r.status === 'fulfilled' ? r.value : null);

  const series = value(fundamentals)?.timeseries?.result ?? [];
  const eps = latestReported(series, 'trailingDilutedEPS')?.value ?? null;
  const reportedCap = latestReported(series, 'trailingMarketCap');

  const stats = { eps, sharesOutstanding: null, dividendsTTM: null, avgVolume: null, beta: null };

  const day = value(daily)?.chart?.result?.[0];
  if (day) {
    const ts = day.timestamp ?? [];
    const quote = day.indicators?.quote?.[0] ?? {};
    const offset = day.meta?.gmtoffset ?? 0;
    const dateOf = t => new Date((t + offset) * 1000).toISOString().slice(0, 10);

    // Exclude the latest bar — it may be today's still-open session.
    const vols = (quote.volume ?? []).slice(0, -1).filter(v => v != null).slice(-AVG_VOLUME_DAYS);
    if (vols.length) stats.avgVolume = vols.reduce((a, b) => a + b, 0) / vols.length;

    const divs = Object.values(day.events?.dividends ?? {});
    stats.dividendsTTM = divs
      .filter(d => d.date >= now - 365 * DAY_S)
      .reduce((sum, d) => sum + d.amount, 0);

    if (reportedCap?.value) {
      // Close on (or the last session before) the market cap's as-of date.
      let close = null;
      for (let i = 0; i < ts.length && dateOf(ts[i]) <= reportedCap.asOfDate; i++) {
        if (quote.close?.[i] != null) close = quote.close[i];
      }
      if (close) stats.sharesOutstanding = reportedCap.value / close;
    }
  }

  const stockMonthly = value(monthly)?.chart?.result?.[0];
  const marketResult = value(marketMonthly)?.chart?.result?.[0];
  if (stockMonthly && marketResult) {
    stats.beta = computeBeta(monthlyReturns(stockMonthly), monthlyReturns(marketResult));
  }

  return stats;
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

// Smallest thumbnail rendition — the news list shows it at ~56px.
function pickThumbnail(thumbnail) {
  const res = thumbnail?.resolutions ?? [];
  const small = res.find(r => r.tag === '140x140') ?? res.slice().sort((a, b) => a.width - b.width)[0];
  return small?.url ?? null;
}

/**
 * Fetch recent news tagged to a ticker, via Yahoo's search endpoint.
 * Items use the same shape as services/rss.js articles
 * ({ title, link, pubDate, description, image, source }) so the shared
 * article viewer (utils/articleViewer.js) handles them unchanged.
 * Yahoo supplies no summary text, so `description` is always ''.
 */
export async function fetchTickerNews(symbol, count = 20) {
  const url = `${BASE}/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=${count}`;
  const data = await fetchWithFallback(url);
  return (data?.news ?? [])
    .filter(n => n.title && n.link)
    .map(n => ({
      title: n.title,
      link: n.link,
      pubDate: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : '',
      description: '',
      image: pickThumbnail(n.thumbnail),
      source: n.publisher ?? 'Yahoo Finance',
    }))
    .sort((a, b) => (b.pubDate || '').localeCompare(a.pubDate || ''));
}

/**
 * Search symbols by ticker or company name (Yahoo's search endpoint), for
 * adding stocks to a watchlist. Returns [{ symbol, name, exchange, type }].
 */
export async function searchSymbols(query, count = 8) {
  const q = query.trim();
  if (!q) return [];
  const url = `${BASE}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=${count}&newsCount=0&enableFuzzyQuery=false`;
  const data = await fetchWithFallback(url);
  return (data?.quotes ?? [])
    .filter(r => r.symbol && r.isYahooFinance !== false)
    .map(r => ({
      symbol: r.symbol.toUpperCase(),
      name: r.shortname || r.longname || r.symbol,
      exchange: r.exchDisp || r.exchange || '',
      type: r.typeDisp || r.quoteType || '',
    }));
}

// symbol → Promise<{ sector, industry } | null>, kept for the page's lifetime
// (a company's sector doesn't change between refreshes).
const profileCache = new Map();

/**
 * A stock's sector and industry (e.g. Energy / Oil & Gas Integrated), from
 * Yahoo's search endpoint — the profile endpoint needs an auth crumb this
 * app doesn't have. Only equities have one; funds, crypto, etc. return null.
 */
export function fetchSector(symbol) {
  if (!profileCache.has(symbol)) {
    const url = `${BASE}/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=5&newsCount=0&enableFuzzyQuery=false`;
    const p = fetchWithFallback(url)
      .then(data => {
        const q = (data?.quotes ?? []).find(r => r.symbol?.toUpperCase() === symbol.toUpperCase());
        const sector = q?.sectorDisp || q?.sector || null;
        return sector ? { sector, industry: q.industryDisp || q.industry || null } : null;
      })
      .catch(err => {
        profileCache.delete(symbol); // let a later refresh retry
        throw err;
      });
    profileCache.set(symbol, p);
  }
  return profileCache.get(symbol);
}
