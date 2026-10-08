/**
 * Server-side view of a user's portfolios (settings.portfolios — see
 * utils/portfolios.js), for alerts: every portfolio's stock positions and
 * option contracts combined. Older settings with a single top-level
 * portfolio are read as-is.
 */
function mergeInto(target, key, pos) {
  if (!pos || !(Number(pos.quantity) > 0)) return;
  const cur = target[key];
  if (!cur) { target[key] = { ...pos }; return; }
  const quantity = cur.quantity + pos.quantity;
  target[key] = { ...cur, quantity, avgCost: (cur.quantity * cur.avgCost + pos.quantity * pos.avgCost) / quantity };
}

/** settings → { portfolio: { SYMBOL: pos }, optionPositions: { OCC: pos } } */
function allPositions(settings = {}) {
  const list = Array.isArray(settings.portfolios)
    ? settings.portfolios
    : [{ portfolio: settings.portfolio, optionPositions: settings.optionPositions }];
  const out = { portfolio: {}, optionPositions: {} };
  for (const pf of list) {
    for (const [sym, pos] of Object.entries(pf?.portfolio ?? {})) mergeInto(out.portfolio, sym, pos);
    for (const [occ, pos] of Object.entries(pf?.optionPositions ?? {})) mergeInto(out.optionPositions, occ, pos);
  }
  return out;
}

module.exports = { allPositions };
