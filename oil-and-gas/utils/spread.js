/**
 * Simple price spread between two instruments (same unit, e.g. USD/bbl).
 * Returns { value, pct } where pct is spread as % of priceA.
 */
export function calcSpread(priceA, priceB) {
  const value = priceA - priceB;
  const pct = priceA !== 0 ? (value / priceA) * 100 : 0;
  return { value, pct };
}

/**
 * 3-2-1 crack spread.
 *
 * Formula: (2 × gasoline_bbl + 1 × diesel_bbl − 3 × crude_bbl) / 3
 *
 * @param {number} gasPriceUSDgal   - RBOB or retail gasoline price in USD/gallon
 * @param {number} dieselPriceUSDgal - ULSD/diesel price in USD/gallon
 * @param {number} crudePriceUSDbbl  - WTI or Brent price in USD/barrel
 * @returns {number} crack spread in USD/barrel
 */
export function calcCrackSpread(gasPriceUSDgal, dieselPriceUSDgal, crudePriceUSDbbl) {
  const GALS_PER_BBL = 42;
  const gasoline_bbl = gasPriceUSDgal * GALS_PER_BBL;
  const diesel_bbl = dieselPriceUSDgal * GALS_PER_BBL;
  return (2 * gasoline_bbl + 1 * diesel_bbl - 3 * crudePriceUSDbbl) / 3;
}
