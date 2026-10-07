/**
 * Upcoming earnings dates via the server's relay to Nasdaq/Zacks
 * (server/events.js) → { SYMBOL: { date, time, confirmed, quarter,
 * epsForecast, epsLastYear } | null }. Kept for an hour in this tab, and
 * requested in batches, so a whole watchlist costs one request.
 */
const TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // symbol → { at, value }

export async function fetchEarnings(symbols) {
  const now = Date.now();
  const out = {};
  const missing = [];
  for (const s of new Set(symbols.map(x => x.toUpperCase()))) {
    const hit = cache.get(s);
    if (hit && now - hit.at < TTL_MS) out[s] = hit.value;
    else missing.push(s);
  }
  for (let i = 0; i < missing.length; i += 60) {
    const batch = missing.slice(i, i + 60);
    const res = await fetch(`/api/events/earnings?symbols=${encodeURIComponent(batch.join(','))}`);
    if (!res.ok) throw new Error(`Earnings HTTP ${res.status}`);
    const { earnings } = await res.json();
    for (const s of batch) {
      out[s] = earnings[s] ?? null;
      cache.set(s, { at: now, value: out[s] });
    }
  }
  return out;
}
