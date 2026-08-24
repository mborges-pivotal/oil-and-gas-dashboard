/**
 * Yahoo Finance unofficial API service.
 * Uses query1.finance.yahoo.com with allorigins.win as CORS fallback.
 */

const BASE = 'https://query1.finance.yahoo.com';
const PROXY = 'https://api.allorigins.win/raw?url=';

async function fetchWithFallback(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch {
    // CORS fallback via allorigins proxy
    const proxied = PROXY + encodeURIComponent(url);
    const res = await fetch(proxied, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
    return res.json();
  }
}

/**
 * Fetch current quote data for a single symbol.
 * Returns: { symbol, shortName, price, previousClose, change, pctChange, currency }
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
    currency: meta.currency ?? 'USD',
  };
}

/**
 * Fetch batch quotes for multiple symbols using the v7 endpoint.
 * Returns an array of quote objects.
 */
export async function fetchBatchQuotes(symbols) {
  if (!symbols.length) return [];
  const joined = symbols.map(encodeURIComponent).join(',');
  const url = `${BASE}/v7/finance/quote?symbols=${joined}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketChange,regularMarketVolume,shortName,currency`;
  const data = await fetchWithFallback(url);
  const results = data?.quoteResponse?.result ?? [];
  return results.map(q => ({
    symbol: q.symbol,
    shortName: q.shortName ?? q.symbol,
    price: q.regularMarketPrice ?? null,
    change: q.regularMarketChange ?? null,
    pctChange: q.regularMarketChangePercent ?? null,
    volume: q.regularMarketVolume ?? null,
    currency: q.currency ?? 'USD',
  }));
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
