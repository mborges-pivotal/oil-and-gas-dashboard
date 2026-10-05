/**
 * Alert wording and presets shared by the stock card's Alerts tab.
 * Conditions mirror server/alerts.js (which does the evaluating).
 */
import { formatPrice } from './formatters.js';

const pct = v => `${Math.round(v * 100) / 100}%`;

export const ALERT_KINDS = [
  { id: 'price',    label: 'Price target' },
  { id: 'daily',    label: 'Daily move' },
  { id: 'position', label: 'Position gain/loss' },
  { id: 'high52',   label: '52-week high' },
  { id: 'low52',    label: '52-week low' },
  { id: 'volume',   label: 'Volume spike' },
];

/** One-line description of an alert's condition. */
export function describeAlert(a) {
  const p = a.params;
  switch (a.kind) {
    case 'price':
      return `Price ${p.direction} ${formatPrice(p.target)}`
        + (p.basis === 'percent' ? ` (${p.percent >= 0 ? '+' : ''}${pct(p.percent)} from ${formatPrice(p.basePrice)})` : '');
    case 'daily':
      return `${p.direction === 'either' ? 'Moves ±' : p.direction === 'up' ? 'Up ' : 'Down '}${pct(p.percent)} or more in a day`;
    case 'position':
      return `Position ${p.direction} of ${pct(p.percent)} vs. average cost`;
    case 'high52':
      return p.within ? `Within ${pct(p.within)} of the 52-week high` : 'Reaches a new 52-week high';
    case 'low52':
      return p.within ? `Within ${pct(p.within)} of the 52-week low` : 'Reaches a new 52-week low';
    case 'volume':
      return `Volume ${p.multiple}× the 3-month average`;
    default:
      return a.kind;
  }
}

/**
 * One-tap starting points for a new alert, given the stock's quote and
 * whether you hold it. Each opens the form prefilled; nothing is saved
 * until you press Save.
 */
export function alertPresets({ hasPosition }) {
  return [
    { label: 'Above +5%',     kind: 'price',  params: { direction: 'above', basis: 'percent', percent: 5 } },
    { label: 'Below −5%',     kind: 'price',  params: { direction: 'below', basis: 'percent', percent: -5 } },
    { label: 'Up 3% today',   kind: 'daily',  params: { direction: 'up', percent: 3 }, repeat: 'daily' },
    { label: 'Down 3% today', kind: 'daily',  params: { direction: 'down', percent: 3 }, repeat: 'daily' },
    ...(hasPosition ? [
      { label: '+20% gain',   kind: 'position', params: { direction: 'gain', percent: 20 } },
      { label: '−10% loss',   kind: 'position', params: { direction: 'loss', percent: 10 } },
    ] : []),
    { label: '52-wk high',    kind: 'high52', params: { within: 0 } },
    { label: 'Volume 2×',     kind: 'volume', params: { multiple: 2 }, repeat: 'daily' },
  ];
}
