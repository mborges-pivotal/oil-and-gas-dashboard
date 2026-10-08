/**
 * Multiple portfolios. config.portfolios is a list of
 *   { id, name, portfolio: { SYMBOL: position }, optionPositions: { OCC: position },
 *     closedPositions: [record] }
 * — each with the same shapes the single portfolio used to have at the top
 * level of the config (config.portfolio / optionPositions / closedPositions).
 * Older configs are migrated into one portfolio named "Main".
 * Mirrored on the server by server/portfolios.js (for alerts).
 */

export const DEFAULT_PORTFOLIO_NAME = 'Main';
const LEGACY_KEYS = ['portfolio', 'optionPositions', 'closedPositions'];

export const newPortfolioId = () => 'pf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export function emptyPortfolio(name, id = newPortfolioId()) {
  return { id, name, portfolio: {}, optionPositions: {}, closedPositions: [] };
}

/** Move a single top-level portfolio into config.portfolios. Mutates; true if it changed anything. */
export function migratePortfolios(config) {
  const hasLegacy = LEGACY_KEYS.some(k => k in config);
  if (Array.isArray(config.portfolios) && !hasLegacy) return false;
  const list = Array.isArray(config.portfolios) ? config.portfolios : [];
  const legacy = {
    portfolio: config.portfolio ?? {},
    optionPositions: config.optionPositions ?? {},
    closedPositions: config.closedPositions ?? [],
  };
  const anything = Object.keys(legacy.portfolio).length || Object.keys(legacy.optionPositions).length || legacy.closedPositions.length;
  if (anything) list.unshift({ ...emptyPortfolio(DEFAULT_PORTFOLIO_NAME, 'pf_main'), ...legacy });
  config.portfolios = list;
  for (const k of LEGACY_KEYS) delete config[k];
  return true;
}

export const portfolioList = config => (Array.isArray(config?.portfolios) ? config.portfolios : []);

// Two holdings of the same thing → one: quantities add, the average cost is
// share-weighted, trades are combined.
function mergeInto(target, key, pos, extra = {}) {
  if (!pos || !(pos.quantity > 0)) return;
  const cur = target[key];
  if (!cur) {
    target[key] = { ...pos, ...extra, transactions: [...(pos.transactions ?? [])] };
    return;
  }
  const quantity = cur.quantity + pos.quantity;
  target[key] = {
    ...cur,
    quantity,
    avgCost: (cur.quantity * cur.avgCost + pos.quantity * pos.avgCost) / quantity,
    transactions: [...cur.transactions, ...(pos.transactions ?? [])],
  };
}

/** Every portfolio as one (read-only) — for the account Summary and alerts. */
export function mergePortfolios(list) {
  const merged = { id: null, name: 'All portfolios', merged: true, portfolio: {}, optionPositions: {}, closedPositions: [] };
  for (const pf of list ?? []) {
    for (const [sym, pos] of Object.entries(pf.portfolio ?? {})) mergeInto(merged.portfolio, sym, pos);
    for (const [occ, pos] of Object.entries(pf.optionPositions ?? {})) {
      // A contract held long in one portfolio and short in another doesn't net out here.
      const key = merged.optionPositions[occ] && merged.optionPositions[occ].side !== pos?.side ? `${occ}#${pf.id}` : occ;
      mergeInto(merged.optionPositions, key, pos);
    }
    merged.closedPositions.push(...(pf.closedPositions ?? []).map(c => ({ ...c, portfolioId: pf.id })));
  }
  return merged;
}

/**
 * A portfolio's headline numbers at the current quotes:
 * { value, cost, gain, allTimePct, dayGain, dayPct, positions, priced }.
 * quoteOf(symbol) → { price, change } (stocks and option contracts alike).
 * Short options count as negative value (a liability) and negative cost (a
 * credit). All-time % is the gain over the money invested — cash holdings
 * (isCash) count in the value but not in that base, since they don't gain.
 */
export function summarizePortfolio(pf, quoteOf, isCash = () => false, multiplier = 100) {
  let value = 0, cost = 0, invested = 0, dayGain = 0, positions = 0, priced = true, anyChange = false;
  const add = (qty, avg, q, sign = 1, m = 1, cash = false) => {
    positions++;
    cost += sign * qty * m * avg;
    if (!cash) invested += qty * m * avg;
    if (q?.price == null) { priced = false; return; }
    value += sign * qty * m * q.price;
    if (q.change != null) { dayGain += sign * qty * m * q.change; anyChange = true; }
  };
  for (const [sym, p] of Object.entries(pf?.portfolio ?? {})) if (p?.quantity > 0) add(p.quantity, p.avgCost, quoteOf(sym), 1, 1, isCash(sym, p));
  for (const [occ, p] of Object.entries(pf?.optionPositions ?? {})) {
    if (p?.quantity > 0) add(p.quantity, p.avgCost, quoteOf(occ), p.side === 'short' ? -1 : 1, p.multiplier ?? multiplier);
  }
  if (!priced) return { value: null, cost, gain: null, allTimePct: null, dayGain: null, dayPct: null, positions, priced };
  const gain = value - cost;
  const prev = value - dayGain;
  return {
    value, cost, gain, positions, priced,
    allTimePct: invested > 0 ? (gain / invested) * 100 : null,
    dayGain: anyChange ? dayGain : null,
    dayPct: anyChange && prev > 0 ? (dayGain / prev) * 100 : null,
  };
}
