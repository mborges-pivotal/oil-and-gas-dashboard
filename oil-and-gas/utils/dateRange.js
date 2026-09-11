/**
 * Shared range-picker options and cutoff logic for historical charts
 * (Gas Prices retail history, Oil Prices spread history).
 */
export const RANGE_OPTIONS = [
  { id: '1M', label: '1M' },
  { id: '3M', label: '3M' },
  { id: '6M', label: '6M' },
  { id: 'YTD', label: 'YTD' },
  { id: '1Y', label: '1Y' },
  { id: '2Y', label: '2Y' },
  { id: '5Y', label: '5Y' },
];

/**
 * Pick x-axis tick indices at calendar-month boundaries from an ascending
 * series of { period } (date string) entries. Thins to at most `maxTicks`
 * by skipping whole months (rather than picking arbitrary days) when the
 * range spans more months than can be labeled without crowding — e.g. a 5Y
 * chart gets every-5th-month ticks instead of one per month.
 *
 * Each label is "MMM" (e.g. "Jan"), or "MMM 'YY" the first time a new year
 * appears, so a range that crosses a year boundary stays unambiguous.
 */
export function monthlyTicks(data, maxTicks = 12) {
  if (!data.length) return [];

  const monthStarts = [];
  let lastMonthKey = null;
  data.forEach((d, i) => {
    const date = new Date(d.period);
    const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
    if (monthKey !== lastMonthKey) {
      monthStarts.push({ i, date });
      lastMonthKey = monthKey;
    }
  });

  const stride = Math.max(1, Math.ceil(monthStarts.length / maxTicks));
  const picked = monthStarts.filter((_, idx) => idx % stride === 0);

  let lastYear = null;
  return picked.map(({ i, date }) => {
    const year = date.getFullYear();
    const label = year !== lastYear
      ? date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
      : date.toLocaleDateString('en-US', { month: 'short' });
    lastYear = year;
    return { i, label };
  });
}

// Rough average glyph width for the 10px chart-axis-label font — precise
// enough to catch the one collision that matters here: the edge-anchored
// first/last tick (which draws its full label width to one side of its
// point, unlike the centered ticks between them) butting up against its
// nearest neighbor with no gap.
const AXIS_LABEL_CHAR_PX = 5.5;
const MIN_GAP_PX = 4;

/**
 * Given tick objects with pixel `x` and `label` (as produced by mapping
 * monthlyTicks() through a chart's xAt()), drop the tick next to each edge
 * if it would crowd the edge tick's label. Edge ticks are anchored 'start'/
 * 'end' so their text runs inward from the axis boundary; a middle-anchored
 * neighbor a fixed month-interval away can end up under that same text.
 */
export function dropEdgeTickCollisions(ticks) {
  if (ticks.length < 3) return ticks;
  const result = ticks.slice();

  const firstWidth = result[0].label.length * AXIS_LABEL_CHAR_PX;
  const secondHalfWidth = (result[1].label.length * AXIS_LABEL_CHAR_PX) / 2;
  if (result[1].x - secondHalfWidth < result[0].x + firstWidth + MIN_GAP_PX) {
    result.splice(1, 1);
  }

  if (result.length >= 3) {
    const n = result.length;
    const lastWidth = result[n - 1].label.length * AXIS_LABEL_CHAR_PX;
    const secondLastHalfWidth = (result[n - 2].label.length * AXIS_LABEL_CHAR_PX) / 2;
    if (result[n - 1].x - lastWidth - MIN_GAP_PX < result[n - 2].x + secondLastHalfWidth) {
      result.splice(n - 2, 1);
    }
  }

  return result;
}

export function cutoffDateFor(rangeId) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  switch (rangeId) {
    case '1M': return new Date(y, m - 1, d);
    case '3M': return new Date(y, m - 3, d);
    case '6M': return new Date(y, m - 6, d);
    case 'YTD': return new Date(y, 0, 1);
    case '1Y': return new Date(y - 1, m, d);
    case '2Y': return new Date(y - 2, m, d);
    case '5Y': return new Date(y - 5, m, d);
    default: return new Date(0);
  }
}
