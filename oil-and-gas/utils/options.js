/**
 * Listed equity options: the OCC contract symbol Yahoo quotes them by
 * (XOM261218C00170000 = XOM, 2026-12-18, Call, strike 170.000), labels,
 * days to expiration, moneyness and breakeven. Yahoo's option chains need
 * authentication, so contracts are entered by hand and checked by fetching
 * the quote for the symbol built here. Mirrors server/alerts.js parseOcc.
 */

export const MULTIPLIER = 100; // shares per standard contract
const OCC_RE = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
const ROOT_RE = /^[A-Z]{1,6}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Can this ticker have listed options we can quote (plain US tickers)? */
export function optionable(underlying) {
  return ROOT_RE.test(underlying ?? '');
}

/** { underlying, expiry: 'YYYY-MM-DD', type: 'call'|'put', strike } → OCC symbol. */
export function occSymbol({ underlying, expiry, type, strike }) {
  const [y, m, d] = expiry.split('-');
  const k = String(Math.round(Number(strike) * 1000)).padStart(8, '0');
  return `${underlying}${y.slice(2)}${m}${d}${type === 'put' ? 'P' : 'C'}${k}`;
}

/** OCC symbol → { underlying, expiry, type, strike } or null. */
export function parseOcc(symbol) {
  const m = OCC_RE.exec(symbol ?? '');
  if (!m) return null;
  return { underlying: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] === 'P' ? 'put' : 'call', strike: Number(m[6]) / 1000 };
}

export const isOptionSymbol = symbol => parseOcc(symbol) != null;

const strikeText = k => (Number.isInteger(k) ? String(k) : String(Math.round(k * 1000) / 1000));

/** "XOM Dec 18 '26 170 Call" (withUnderlying false → "Dec 18 '26 170 Call"). */
export function optionLabel(c, { withUnderlying = true, short = false } = {}) {
  const o = typeof c === 'string' ? parseOcc(c) : c;
  if (!o) return String(c);
  const [y, m, d] = o.expiry.split('-');
  const type = short ? (o.type === 'put' ? 'P' : 'C') : (o.type === 'put' ? 'Put' : 'Call');
  return `${withUnderlying ? o.underlying + ' ' : ''}${MONTHS[Number(m) - 1]} ${Number(d)} '${y.slice(2)} ${strikeText(o.strike)} ${type}`;
}

/** Calendar days from today (local) to expiration; negative once expired. */
export function daysToExpiry(expiry, today = new Date()) {
  const [y, m, d] = expiry.split('-').map(Number);
  const end = Date.UTC(y, m - 1, d);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((end - now) / 86400000);
}

/** 'itm' | 'atm' | 'otm' for the underlying's price, or null without one. */
export function moneyness({ type, strike }, price) {
  if (!(price > 0)) return null;
  if (Math.abs(price - strike) / strike < 0.0025) return 'atm';
  const itm = type === 'call' ? price > strike : price < strike;
  return itm ? 'itm' : 'otm';
}

/** Underlying price at expiration where the position breaks even. */
export function breakeven({ type, strike }, premium) {
  return type === 'call' ? strike + premium : strike - premium;
}

/** The standard monthly expiration (third Friday) at least `minDays` out. */
export function nextMonthlyExpiry(minDays = 7, today = new Date()) {
  for (let i = 0; i < 24; i++) {
    const first = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const firstFriday = 1 + ((5 - first.getDay() + 7) % 7);
    const third = new Date(first.getFullYear(), first.getMonth(), firstFriday + 14);
    const iso = third.toLocaleDateString('en-CA');
    if (daysToExpiry(iso, today) >= minDays) return iso;
  }
  return null;
}

/** A sensible starting strike near the price: whole dollars, 5s or 10s. */
export function nearStrike(price) {
  if (!(price > 0)) return '';
  const step = price < 25 ? 1 : price < 200 ? 5 : 10;
  return String(Math.round(price / step) * step);
}
