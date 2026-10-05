/**
 * Portfolio allocation helpers — asset categories (from Yahoo's instrument
 * type, overridable per position) and folding a breakdown into donut slices.
 */

// Display order; also the order slices are drawn and colored in.
export const CATEGORIES = [
  { id: 'stocks',      label: 'Stocks' },
  { id: 'funds',       label: 'Funds' },
  { id: 'bonds',       label: 'Bonds' },
  { id: 'cash',        label: 'Cash' },
  { id: 'crypto',      label: 'Crypto' },
  { id: 'commodities', label: 'Commodities' },
  { id: 'other',       label: 'Other' },
];
export const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map(c => [c.id, c.label]));
// Legend names where the full label won't fit a phone-width legend column.
export const CATEGORY_SHORT = Object.fromEntries(CATEGORIES.filter(c => c.short).map(c => [c.id, c.short]));

// Fixed color slot (--series-N) per category, so a category keeps its color
// in both charts (by asset type and by sector). "Other" is neutral gray.
const CATEGORY_SLOTS = { stocks: 1, funds: 2, bonds: 3, cash: 4, crypto: 5, commodities: 6 };

/**
 * Give each slice a color slot: categories their fixed one; anything else
 * (sectors) the first slots no category in this chart is using. With at most
 * 6 slices there's always a free one among the 8.
 */
export function assignSlots(slices) {
  const used = new Set(slices.map(s => CATEGORY_SLOTS[s.key]).filter(Boolean));
  const free = [1, 7, 8, 6, 5, 4, 3, 2].filter(n => !used.has(n));
  return slices.map(s => ({ ...s, slot: s.other ? null : (CATEGORY_SLOTS[s.key] ?? free.shift()) }));
}

// Compact legend names for Yahoo's longer sector names (full name stays in
// tooltips, the center readout and the screen-reader table).
const SHORT_SECTORS = {
  'Communication Services': 'Comm. Services',
  'Consumer Cyclical': 'Cons. Cyclical',
  'Consumer Defensive': 'Cons. Defensive',
  'Financial Services': 'Financials',
  'Basic Materials': 'Materials',
  'Technology': 'Tech',
};
export function shortSector(name) {
  return SHORT_SECTORS[name] ?? name;
}

// Yahoo instrumentType → category. Bonds has no instrument type of its own
// (bond funds are ETF/MUTUALFUND) — that one is chosen per position.
const BY_INSTRUMENT_TYPE = {
  EQUITY: 'stocks',
  ETF: 'funds',
  MUTUALFUND: 'funds',
  CRYPTOCURRENCY: 'crypto',
  MONEYMARKET: 'cash',
  FUTURE: 'commodities',
  COMMODITY: 'commodities',
};

/** Automatic category for a Yahoo instrument type ('other' if unknown). */
export function autoCategory(instrumentType) {
  return BY_INSTRUMENT_TYPE[instrumentType] ?? 'other';
}

// A donut stays readable at ≤ 6 slices; past that the smallest fold into "Other".
export const MAX_SLICES = 6;

/**
 * Sum items into slices and fold the tail into "Other".
 *   items: [{ key, label, value, symbol }]
 *   order: keys in display order (unlisted keys sort after, alphabetically)
 * Returns [{ key, label, value, symbols, other }] in display order, Other last.
 */
export function buildSlices(items, order = []) {
  const groups = new Map();
  for (const it of items) {
    if (!(it.value > 0)) continue;
    const g = groups.get(it.key) ?? { key: it.key, label: it.label, short: it.short, value: 0, symbols: [], other: it.key === 'other' };
    g.value += it.value;
    if (it.symbol) g.symbols.push(it.symbol);
    groups.set(it.key, g);
  }
  let slices = [...groups.values()];
  if (slices.length > MAX_SLICES) {
    // Keep the largest MAX_SLICES − 1; everything else becomes "Other".
    const ranked = slices.filter(s => !s.other).sort((a, b) => b.value - a.value);
    const keep = ranked.slice(0, MAX_SLICES - 1);
    const rest = slices.filter(s => !keep.includes(s));
    slices = [...keep, {
      key: 'other', label: 'Other', other: true,
      value: rest.reduce((sum, s) => sum + s.value, 0),
      symbols: rest.flatMap(s => s.symbols),
    }];
  }
  const rank = k => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  return slices.sort((a, b) =>
    (a.other - b.other) || (rank(a.key) - rank(b.key)) || a.label.localeCompare(b.label)
  );
}
