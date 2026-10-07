/**
 * Period returns for the Summary tab: 5 and 10 trading days, 1/3/6 months,
 * year to date, 1/2/5/10 years. Each period's base is the last close on or
 * before the start date (YTD: the last close of the previous year), measured
 * to the latest close. Price change uses closes; total return uses adjusted
 * closes (dividends reinvested).
 */
export const PERIODS = [
  { id: '5D',  label: '5 days',   days: 5 },
  { id: '10D', label: '10 days',  days: 10 },
  { id: '1M',  label: '1 month',  months: 1 },
  { id: '3M',  label: '3 months', months: 3 },
  { id: '6M',  label: '6 months', months: 6 },
  { id: 'YTD', label: 'Year to date', ytd: true },
  { id: '1Y',  label: '1 year',   months: 12 },
  { id: '2Y',  label: '2 years',  months: 24 },
  { id: '5Y',  label: '5 years',  months: 60 },
  { id: '10Y', label: '10 years', months: 120 },
];

// YYYY-MM-DD shifted back by whole months (clamped to the month's last day).
function monthsBefore(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) - n;
  const ty = Math.floor(total / 12);
  const tm = total % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// Index of the last date on or before `target` (dates ascending), or -1.
function lastOnOrBefore(dates, target) {
  let lo = 0, hi = dates.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= target) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** history: { dates, close, adjClose } → { [periodId]: { from, price, total } | null } */
export function computePerformance(history) {
  const out = {};
  const n = history?.dates?.length ?? 0;
  if (!n) return out;
  const L = n - 1;
  const lastDate = history.dates[L];
  Object.defineProperty(out, 'latest', { value: lastDate, enumerable: false });
  for (const p of PERIODS) {
    let b;
    if (p.days) b = L - p.days;
    else if (p.ytd) b = lastOnOrBefore(history.dates, `${Number(lastDate.slice(0, 4)) - 1}-12-31`);
    else {
      const target = monthsBefore(lastDate, p.months);
      // Not enough history (e.g. a newer listing): no figure rather than a shorter period.
      b = target < history.dates[0] ? -1 : lastOnOrBefore(history.dates, target);
    }
    if (b < 0 || b >= L) { out[p.id] = null; continue; }
    out[p.id] = {
      from: history.dates[b],
      price: (history.close[L] / history.close[b] - 1) * 100,
      total: (history.adjClose[L] / history.adjClose[b] - 1) * 100,
    };
  }
  return out;
}
