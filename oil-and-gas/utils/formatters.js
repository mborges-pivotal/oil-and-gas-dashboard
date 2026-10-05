/**
 * Currency formatter — USD with 2 decimal places.
 */
export function formatUSD(value) {
  if (value == null || isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Percent formatter with sign, 2 decimal places.
 */
export function formatPct(value) {
  if (value == null || isNaN(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

/**
 * Percent formatter for an absolute level (no +/- sign) — e.g. an
 * unemployment rate or bond yield, as opposed to formatPct's use for a
 * change/delta where the sign is the point.
 */
export function formatPercentLevel(value) {
  if (value == null || isNaN(value)) return '—';
  return `${value.toFixed(2)}%`;
}

/**
 * Plain number formatter (thousands separator, 2 decimals, no currency
 * symbol) — for values like stock market indexes that aren't dollar-
 * denominated, unlike a stock price. Pass `signed: true` to prepend a '+'
 * for non-negative values (matches formatPct's convention), for a
 * change/delta display.
 */
export function formatNumber(value, { signed = false } = {}) {
  if (value == null || isNaN(value)) return '—';
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return signed && value >= 0 ? `+${formatted}` : formatted;
}

/**
 * Large number abbreviation (e.g. 1.4M, 23.5B).
 */
export function formatVolume(value) {
  if (value == null || isNaN(value)) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

/**
 * Large dollar amount abbreviation (e.g. $662.96B, $1.20T) — for market cap.
 */
export function formatLargeUSD(value) {
  if (value == null || isNaN(value)) return '—';
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  return formatUSD(value);
}

/**
 * Relative age of an ISO timestamp — "5m ago", "3h ago", "2d ago".
 */
export function formatRelativeTime(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/**
 * Format a date string or epoch to "MMM D, YYYY".
 */
export function formatDate(value) {
  if (!value) return '—';
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Return CSS class name for a numeric change value.
 */
export function changeClass(value) {
  if (value == null || isNaN(value)) return '';
  return value >= 0 ? 'positive' : 'negative';
}
