/**
 * FRED (Federal Reserve Economic Data) API service.
 * Base: https://api.stlouisfed.org/fred
 *
 * Requires a free API key: https://fred.stlouisfed.org/docs/api/api_key.html
 *
 * CORS: api.stlouisfed.org sends no Access-Control-Allow-Origin header, so
 * direct browser fetches fail — same situation as Yahoo Finance/SEC EDGAR.
 * Falls back through the local relay (server.js's /proxy), same pattern as
 * services/edgar.js.
 */

const BASE = 'https://api.stlouisfed.org/fred';
const LOCAL_PROXY = '/proxy?url=';

async function fredFetch(seriesId, apiKey, observationStart) {
  const url = new URL(`${BASE}/series/observations`);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('sort_order', 'asc');
  if (observationStart) url.searchParams.set('observation_start', observationStart);
  const target = url.toString();

  let res;
  try {
    res = await fetch(target, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    res = await fetch(LOCAL_PROXY + encodeURIComponent(target), { cache: 'no-store' });
    if (!res.ok) throw new Error(`FRED API HTTP ${res.status} (via local proxy). Is the server running?`);
  }
  const json = await res.json();
  if (json.error_code) {
    throw new Error(`FRED API error ${json.error_code}: ${json.error_message ?? 'unknown error'}`);
  }
  return json.observations ?? [];
}

function isoDaysAgo(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/**
 * Fetch a FRED series as an ascending array of { period, value }, dropping
 * FRED's "." missing-observation markers (holidays, no data yet, etc).
 *
 * @param {string} seriesId  FRED series ID, e.g. 'DGS10'
 * @param {string} apiKey    Free FRED API key
 * @param {number} yearsBack How far back to fetch (default 5, matching the
 *   app's other historical charts — range buttons top out at 5Y)
 */
export async function fetchSeriesHistory(seriesId, apiKey, yearsBack = 5) {
  const raw = await fredFetch(seriesId, apiKey, isoDaysAgo(yearsBack));
  return raw
    .filter(o => o.value !== '.')
    .map(o => ({ period: o.date, value: Number(o.value) }));
}

/**
 * CPI year-over-year % change (the commonly-cited "inflation rate"), derived
 * from the raw CPIAUCSL index — FRED doesn't publish this as its own series.
 * Fetches an extra year of lookback so the first displayed month still has
 * a same-month-last-year value to compare against.
 */
export async function fetchCPIYoYHistory(apiKey, yearsBack = 5) {
  const raw = await fredFetch('CPIAUCSL', apiKey, isoDaysAgo(yearsBack + 1));
  const valid = raw
    .filter(o => o.value !== '.')
    .map(o => ({ period: o.date, value: Number(o.value) }));

  // CPIAUCSL is monthly, always stamped on the 1st — so "12 months earlier"
  // is an exact date-string match, no nearest-neighbor search needed.
  const byPeriod = new Map(valid.map(v => [v.period, v.value]));
  const yoy = [];
  for (const v of valid) {
    const priorDate = new Date(v.period);
    priorDate.setFullYear(priorDate.getFullYear() - 1);
    const priorValue = byPeriod.get(priorDate.toISOString().slice(0, 10));
    if (priorValue != null) {
      yoy.push({ period: v.period, value: ((v.value - priorValue) / priorValue) * 100 });
    }
  }

  const cutoff = isoDaysAgo(yearsBack);
  return yoy.filter(r => r.period >= cutoff);
}
