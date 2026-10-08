/**
 * Portfolio IDs — derived from the portfolio's name and unique across every
 * account (the portfolio_ids registry in server/db.js):
 *   "Retirement IRA" → retirement-ira, or retirement-ira-2, -3… when taken.
 * Lowercase letters, digits and single hyphens; 2–40 characters. An ID keeps
 * its value when the portfolio is renamed, and is freed when it's deleted.
 *
 * normalizeSettings() runs on every settings save (server/auth.js) and once
 * for every profile at startup: IDs the user owns are kept, free ones are
 * claimed, and anything else (taken by someone else, malformed, an older
 * "pf_…" ID) gets a fresh one from the name — with Account → Activity's
 * transfers pointed at it.
 */
const db = require('./db');

const MAX_LEN = 40;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isValidId = id => typeof id === 'string' && id.length >= 2 && id.length <= MAX_LEN && ID_RE.test(id);

/** "Retirement IRA" → "retirement-ira"; never empty, never too short. */
function slugify(name) {
  let s = String(name ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, MAX_LEN).replace(/-+$/, '');
  if (!s) s = 'portfolio';
  if (s.length < 2) s = `${s}-portfolio`;
  return s;
}

/** The first of base, base-2, base-3… nobody has. */
function nextFreeId(base) {
  let id = base;
  for (let n = 2; db.portfolioIdOwner(id) !== null; n++) {
    const suffix = `-${n}`;
    id = base.slice(0, MAX_LEN - suffix.length).replace(/-+$/, '') + suffix;
  }
  return id;
}

/** A free ID for `name` (not claimed). */
const suggestId = name => nextFreeId(slugify(name));

/**
 * Claim an ID for a new portfolio: `wanted` exactly (if given and free), or
 * one derived from the name. → { id } | { error, suggestion } when `wanted` is taken/invalid.
 */
function reserveId(userId, name, wanted) {
  if (wanted != null && wanted !== '') {
    if (!isValidId(wanted)) return { error: 'An ID uses lowercase letters, digits and hyphens (2–40 characters)', suggestion: suggestId(name) };
    const owner = db.portfolioIdOwner(wanted);
    if (owner !== null && owner !== userId) return { error: `The ID "${wanted}" is already taken`, suggestion: nextFreeId(wanted) };
    db.registerPortfolioId(wanted, userId);
    return { id: wanted };
  }
  for (;;) {
    const id = suggestId(name);
    if (db.registerPortfolioId(id, userId)) return { id };
  }
}

const LEGACY_KEYS = ['portfolio', 'optionPositions', 'closedPositions'];

/** Make settings.portfolios' IDs valid and unique; mutates. → true if anything changed. */
function normalizeSettings(userId, settings) {
  if (!settings || typeof settings !== 'object') return false;
  let changed = false;
  // A settings file from before multiple portfolios: its positions become "Main".
  if (!Array.isArray(settings.portfolios) && LEGACY_KEYS.some(k => k in settings)) {
    const has = Object.keys(settings.portfolio ?? {}).length || Object.keys(settings.optionPositions ?? {}).length || (settings.closedPositions ?? []).length;
    settings.portfolios = has ? [{ id: null, name: 'Main', portfolio: settings.portfolio ?? {}, optionPositions: settings.optionPositions ?? {}, closedPositions: settings.closedPositions ?? [] }] : [];
    for (const k of LEGACY_KEYS) delete settings[k];
    changed = true;
  }
  if (!Array.isArray(settings.portfolios)) return changed;
  const seen = new Set();
  const renamed = {};
  for (const pf of settings.portfolios) {
    if (!pf || typeof pf !== 'object') continue;
    const id = pf.id;
    let ok = false;
    if (isValidId(id) && !seen.has(id)) {
      const owner = db.portfolioIdOwner(id);
      ok = owner === userId || (owner === null && db.registerPortfolioId(id, userId));
    }
    if (!ok) {
      const { id: fresh } = reserveId(userId, pf.name);
      if (id != null) renamed[id] = fresh;
      pf.id = fresh;
      changed = true;
    }
    seen.add(pf.id);
  }
  if (Object.keys(renamed).length && Array.isArray(settings.transfers)) {
    for (const t of settings.transfers) {
      if (t.fromId in renamed) t.fromId = renamed[t.fromId];
      if (t.toId in renamed) t.toId = renamed[t.toId];
    }
  }
  db.releasePortfolioIds(userId, [...seen]);
  return changed;
}

/** At startup: every profile's portfolio IDs registered and made unique. */
function normalizeAllProfiles() {
  let fixed = 0;
  for (const { userId, settings } of db.profilesWithSettings()) {
    if (normalizeSettings(userId, settings)) {
      db.updateSettings(userId, settings);
      fixed++;
    }
  }
  return fixed;
}

module.exports = { slugify, suggestId, reserveId, normalizeSettings, normalizeAllProfiles, isValidId };
