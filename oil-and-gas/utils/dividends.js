/**
 * Estimate a stock's next ex-dividend date and amount from its dividend
 * history (Yahoo) — there's no free, reliable source for declared dates.
 * Regular payers keep a steady cadence: the next ex-date is the last one
 * plus the typical gap, and the amount is the last one paid. Returns null
 * for irregular payers, or when the dividend looks suspended.
 */
const DAY = 86400000;
const toDay = iso => Date.parse(iso + 'T00:00:00Z');
const toIso = ms => new Date(ms).toISOString().slice(0, 10);

/** dividends: [{ date: 'YYYY-MM-DD', amount }] ascending → { date, amount, frequency } | null */
export function estimateNextDividend(dividends, todayIso = new Date().toLocaleDateString('en-CA')) {
  const recent = (dividends ?? []).slice(-9);
  if (recent.length < 3) return null;
  const gaps = recent.slice(1).map((d, i) => (toDay(d.date) - toDay(recent[i].date)) / DAY).sort((a, b) => a - b);
  const gap = gaps[Math.floor(gaps.length / 2)]; // median, in days
  const cadences = [
    { days: 30, label: 'monthly' }, { days: 91, label: 'quarterly' },
    { days: 182, label: 'semiannual' }, { days: 365, label: 'annual' },
  ];
  const cadence = cadences.find(c => Math.abs(gap - c.days) <= c.days * 0.2);
  if (!cadence) return null; // irregular — no honest estimate
  const last = recent[recent.length - 1];
  const today = toDay(todayIso);
  // Overdue by more than half a cycle: probably cut or suspended.
  if (today - toDay(last.date) > (gap * 1.5) * DAY) return null;
  let next = toDay(last.date) + gap * DAY;
  while (next < today) next += gap * DAY;
  return { date: toIso(next), amount: last.amount, frequency: cadence.label, lastDate: last.date };
}
