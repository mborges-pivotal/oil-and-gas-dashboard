/**
 * Company profile for a stock's Summary tab:
 *  - a brief description: the opening of the company's English Wikipedia
 *    article, found through Wikidata's ticker-symbol data (so XOM → ExxonMobil,
 *    SLB → SLB, never a name-search guess). Yahoo's own description needs
 *    authentication. Funds and many foreign tickers have no Wikidata ticker
 *    link — then there's simply no description.
 *  - facts from SEC EDGAR (official name, industry, headquarters, fiscal year
 *    end) and Yahoo (sector, industry).
 * Cached in this browser for 30 days — descriptions rarely change.
 */
import { resolveCIK, fetchFilings } from './edgar.js';
import { fetchSector } from './yahooFinance.js';

const CACHE_PREFIX = 'oilgas_profile_v1:';
const CACHE_DAYS = 30;
const WIKIDATA = 'https://query.wikidata.org/sparql';
const WIKI_SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
// Prefer a listing on a US exchange when a ticker is used in several markets.
const US_EXCHANGES = ['Q13677', 'Q82059', 'Q1138046']; // NYSE, Nasdaq, NYSE American
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// A slow source shouldn't hold the tab up: give up after 8 seconds.
async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Timed out' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

function readCache(symbol) {
  try {
    const hit = JSON.parse(localStorage.getItem(CACHE_PREFIX + symbol));
    if (hit && Date.now() - hit.at < CACHE_DAYS * 86400000) return hit.data;
  } catch { /* no cache */ }
  return null;
}
function writeCache(symbol, data) {
  try { localStorage.setItem(CACHE_PREFIX + symbol, JSON.stringify({ at: Date.now(), data })); } catch { /* per-browser only */ }
}

/** English Wikipedia article title for a ticker, via Wikidata (null if none). */
async function wikipediaTitle(symbol) {
  // Yahoo writes share classes as BRK-B; Wikidata usually as BRK.B.
  const variants = [...new Set([symbol, symbol.replace(/-/g, '.')])].map(t => JSON.stringify(t)).join(' ');
  // The ticker sits on the company's "stock exchange" statement. (Keep this
  // query simple — a UNION with a direct ticker property times out.)
  const query = `SELECT ?article ?exchange WHERE {
    VALUES ?ticker { ${variants} }
    ?item p:P414 ?st . ?st pq:P249 ?ticker ; ps:P414 ?exchange .
    ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  } LIMIT 10`;
  const res = await fetchWithTimeout(`${WIKIDATA}?format=json&query=${encodeURIComponent(query)}`, { headers: { Accept: 'application/sparql-results+json' } });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  const rows = (await res.json()).results?.bindings ?? [];
  if (!rows.length) return null;
  const qid = r => r.exchange?.value.split('/').pop();
  const best = rows.find(r => US_EXCHANGES.includes(qid(r))) ?? rows[0];
  return decodeURIComponent(best.article.value.split('/wiki/')[1]);
}

async function wikipediaSummary(symbol) {
  const title = await wikipediaTitle(symbol);
  if (!title) return null;
  const res = await fetchWithTimeout(WIKI_SUMMARY + encodeURIComponent(title));
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const j = await res.json();
  if (!j.extract || j.type === 'disambiguation') return null;
  return { text: j.extract, title: j.title, url: j.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}` };
}

async function secFacts(symbol) {
  const cik = await resolveCIK(symbol);
  if (!cik) return null;
  const s = await fetchFilings(cik);
  const addr = s.addresses?.business;
  const fy = /^\d{4}$/.test(s.fiscalYearEnd ?? '') ? `${MONTHS[Number(s.fiscalYearEnd.slice(0, 2)) - 1]} ${Number(s.fiscalYearEnd.slice(2))}` : null;
  const titleCase = t => (t ? t.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : null);
  return {
    name: s.name ?? null,
    secIndustry: s.sicDescription ?? null,
    headquarters: addr?.city ? `${titleCase(addr.city)}${addr.stateOrCountry ? ', ' + addr.stateOrCountry : ''}` : null,
    fiscalYearEnd: fy,
    website: s.website || null,
    cik,
  };
}

/**
 * → { summary: { text, title, url } | null, facts: { name, sector, industry,
 *     secIndustry, headquarters, fiscalYearEnd, website, cik } }
 * Each part is best-effort; it throws only if nothing at all could be found.
 */
export async function fetchCompanyProfile(symbol) {
  const sym = symbol.toUpperCase();
  const cached = readCache(sym);
  if (cached) return cached;
  const [wiki, sec, yahoo] = await Promise.allSettled([wikipediaSummary(sym), secFacts(sym), fetchSector(sym)]);
  const v = r => (r.status === 'fulfilled' ? r.value : null);
  const profile = {
    summary: v(wiki),
    facts: { ...(v(sec) ?? {}), sector: v(yahoo)?.sector ?? null, industry: v(yahoo)?.industry ?? null },
  };
  const failed = [wiki, sec, yahoo].every(r => r.status === 'rejected');
  if (failed) throw new Error(wiki.reason?.message || 'Profile sources unavailable');
  // Only cache a complete answer, so a temporary failure isn't remembered for a month.
  if ([wiki, sec, yahoo].every(r => r.status === 'fulfilled')) writeCache(sym, profile);
  return profile;
}
