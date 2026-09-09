/**
 * EIA Open Data API v2 service.
 * Base: https://api.eia.gov/v2/
 *
 * All endpoints require a free API key (no credit card).
 * Register at: https://www.eia.gov/opendata/
 *
 * CORS: EIA returns Access-Control-Allow-Origin: * — no proxy needed.
 */

const BASE = 'https://api.eia.gov/v2';

/**
 * Internal helper — build and fetch an EIA v2 data request.
 */
async function eiaFetch(path, params) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      v.forEach(val => url.searchParams.append(k, val));
    } else {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), { cache: 'no-store' });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // EIA returns a descriptive body on error responses — surface it instead
    // of just the status code, e.g. {"error":{"code":"...","message":"..."}}
    const detail = json?.error?.message ?? json?.response?.error ?? JSON.stringify(json);
    throw new Error(`EIA API error: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  if (json?.response?.error) throw new Error(`EIA API: ${json.response.error}`);
  return json?.response?.data ?? [];
}

/**
 * Fetch US national average retail gasoline prices (weekly, last N periods).
 *
 * Returns an array of: { period, product, productName, value, units }
 * sorted descending by period.
 *
 * Product codes used:
 *   EPM0   All grades, all formulations
 *   EPMR   Regular
 *   EPMM   Midgrade
 *   EPMP   Premium
 *
 * @param {string} apiKey   Free EIA API key
 * @param {number} length   Number of weekly observations to return (default 12)
 */
export async function fetchGasPrices(apiKey, length = 12) {
  return eiaFetch('/petroleum/pri/gnd/data/', {
    'api_key': apiKey,
    'frequency': 'weekly',
    'data[]': 'value',
    'facets[product][]': ['EPMR', 'EPMM', 'EPMP', 'EPM0'],
    'facets[duoarea][]': 'NUS',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    'length': String(length),
  });
}

/**
 * Fetch US national average retail diesel (ULSD) prices (weekly, last N periods).
 *
 * @param {string} apiKey   Free EIA API key
 * @param {number} length   Number of weekly observations to return (default 12)
 */
export async function fetchDieselPrices(apiKey, length = 12) {
  return eiaFetch('/petroleum/pri/gnd/data/', {
    'api_key': apiKey,
    'frequency': 'weekly',
    'data[]': 'value',
    'facets[product][]': 'EPD2D',
    'facets[duoarea][]': 'NUS',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    'length': String(length),
  });
}

/**
 * Fetch historical weekly prices for a single grade over a long window.
 *
 * fetchGasPrices() above queries all 4 gasoline grades in one request, so its
 * `length` rows are split across them (length=12 → ~3 weeks per grade, not
 * 12). This queries a single product facet, so `weeks` is an accurate count
 * of weekly observations for that one grade — needed for a real N-year chart.
 *
 * @param {string} apiKey   Free EIA API key
 * @param {string} product  EIA product code: EPMR, EPMM, EPMP, EPM0, or EPD2D
 * @param {number} weeks    Number of weekly observations to return (default 260 ≈ 5 years)
 */
export async function fetchGasPriceHistory(apiKey, product, weeks = 260) {
  return eiaFetch('/petroleum/pri/gnd/data/', {
    'api_key': apiKey,
    'frequency': 'weekly',
    'data[]': 'value',
    'facets[product][]': product,
    'facets[duoarea][]': 'NUS',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    'length': String(weeks),
  });
}
