/**
 * SEC EDGAR service.
 *
 * All endpoints are free, no API key required.
 * CORS: data.sec.gov and efts.sec.gov return Access-Control-Allow-Origin: *
 * www.sec.gov (used below for the ticker→CIK lookup) does NOT — browser
 * fetches to it always fail with a generic "Failed to fetch", so it falls
 * back through the local relay (local-proxy.js), same as Yahoo Finance.
 *
 * Rate limit: SEC enforces 10 req/sec per IP.
 * We add a 150ms minimum stagger between company fetches in the component.
 */

const LOCAL_PROXY = 'http://localhost:8787/proxy?url=';

// In-memory session cache
let cikMap = null;                          // ticker (upper) → cik (number)
const submissionsCache = new Map();         // cik_str → submissions data

/**
 * Load the SEC company_tickers.json CIK lookup table.
 * Cached in memory for the lifetime of the page.
 */
export async function loadCIKMap() {
  if (cikMap) return cikMap;
  const url = 'https://www.sec.gov/files/company_tickers.json';
  let json;
  try {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch {
    // CORS fallback via the local relay (node local-proxy.js)
    const res = await fetch(LOCAL_PROXY + encodeURIComponent(url), { cache: 'no-store' });
    if (!res.ok) throw new Error(`EDGAR CIK map: local proxy HTTP ${res.status}. Is 'node local-proxy.js' running?`);
    json = await res.json();
  }
  cikMap = {};
  for (const entry of Object.values(json)) {
    cikMap[entry.ticker.toUpperCase()] = entry.cik_str;
  }
  return cikMap;
}

/**
 * Resolve a ticker symbol to its SEC CIK number.
 * Returns the CIK as a number, or null if not found.
 */
export async function resolveCIK(ticker) {
  const map = await loadCIKMap();
  return map[ticker.toUpperCase()] ?? null;
}

/**
 * Fetch submission history for a given CIK from EDGAR.
 * Returns the raw submissions object.
 *
 * @param {number|string} cik  Numeric CIK (will be zero-padded to 10 digits)
 */
export async function fetchFilings(cik) {
  const padded = `CIK${String(cik).padStart(10, '0')}`;
  const cacheKey = padded;
  if (submissionsCache.has(cacheKey)) return submissionsCache.get(cacheKey);

  const url = `https://data.sec.gov/submissions/${padded}.json`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`EDGAR submissions HTTP ${res.status}`);
  const data = await res.json();
  submissionsCache.set(cacheKey, data);
  return data;
}

/**
 * Extract filings of specific form types from a submissions object.
 * Returns an array of: { form, filingDate, accessionNumber, primaryDocument, description }
 * Sorted descending by filingDate. Capped at maxPerForm results per form type.
 *
 * @param {object}   submissions   Raw EDGAR submissions object
 * @param {string[]} forms         Form types to include, e.g. ['10-K', '10-Q', '8-K']
 * @param {number}   maxPerForm    Max results per form type (default 10)
 */
export function extractFilings(submissions, forms, maxPerForm = 10) {
  const recent = submissions?.filings?.recent;
  if (!recent) return [];

  const {
    form: forms_arr = [],
    filingDate: dates = [],
    accessionNumber: accessions = [],
    primaryDocument: docs = [],
    reportDate: reportDates = [],
  } = recent;

  const countByForm = {};
  const results = [];

  for (let i = 0; i < forms_arr.length; i++) {
    const f = forms_arr[i];
    if (!forms.includes(f)) continue;
    countByForm[f] = (countByForm[f] ?? 0) + 1;
    if (countByForm[f] > maxPerForm) continue;

    results.push({
      form: f,
      filingDate: dates[i] ?? '',
      reportDate: reportDates[i] ?? '',
      accessionNumber: accessions[i] ?? '',
      primaryDocument: docs[i] ?? '',
    });
  }

  return results.sort((a, b) => b.filingDate.localeCompare(a.filingDate));
}

/**
 * Build a direct URL to a filing document on SEC EDGAR.
 *
 * @param {number|string} cik
 * @param {string} accessionNumber  e.g. "0000320193-23-000106"
 * @param {string} primaryDocument  e.g. "aapl-20230930.htm"
 */
export function buildFilingUrl(cik, accessionNumber, primaryDocument) {
  const acc = accessionNumber.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${primaryDocument}`;
}

/**
 * Build the EDGAR filing index URL for an accession number.
 */
export function buildIndexUrl(cik, accessionNumber) {
  const acc = accessionNumber.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/`;
}

/**
 * Return a set of transcript search links for a given ticker.
 * No free API exists for earnings transcripts; these are curated search URLs.
 */
export function getTranscriptLinks(ticker) {
  return [
    {
      label: 'Seeking Alpha — Earnings Transcripts',
      url: `https://seekingalpha.com/symbol/${ticker}/earnings/transcripts`,
    },
    {
      label: 'Motley Fool — Earnings Transcripts',
      url: `https://www.fool.com/earnings-call-transcripts/?ticker=${ticker}`,
    },
    {
      label: 'SEC EDGAR — 8-K Filings (earnings releases)',
      url: `https://efts.sec.gov/LATEST/search-index?q=%22earnings%22&entity=${ticker}&forms=8-K`,
    },
  ];
}
