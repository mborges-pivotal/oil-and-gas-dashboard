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
