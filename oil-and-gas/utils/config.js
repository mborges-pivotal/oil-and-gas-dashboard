import { updateProfile } from '../services/auth.js';
import { migratePortfolios } from './portfolios.js';

const CONFIG_KEY = 'oilgas_config';

// eiaApiKey/fredApiKey are fixed, operator-configured application settings
// (see server.js, which injects them from EIA_API_KEY/FRED_API_KEY env
// vars) — never user-editable, never persisted to localStorage or a user
// profile. Every loadConfig() call re-fetches config.json to pick up their
// current value, even when the rest of the config is already stored.
const API_KEY_FIELDS = ['eiaApiKey', 'fredApiKey'];

// Where settings live: a signed-in user's settings are stored in their
// profile in the server database (so they follow them across browsers);
// anonymous visitors keep using this browser's localStorage.

async function fetchDefaults() {
  const res = await fetch('./config.json', { cache: 'no-store' });
  return res.json();
}

function readLocal() {
  const stored = localStorage.getItem(CONFIG_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null; // corrupted — caller falls back to defaults
  }
}

function withoutApiKeys(config) {
  const copy = { ...config };
  for (const field of API_KEY_FIELDS) delete copy[field];
  return copy;
}

// A stored config can predate any top-level section added to config.json
// since it was first saved — e.g. a new tab's config shipped after the
// user had already been using the app. Backfill only what's entirely
// missing (never touch a key they already have, even if its value differs
// from the current default). Returns true if anything was added.
function backfill(config, serverDefaults) {
  // A single top-level portfolio becomes the first of config.portfolios ("Main").
  let backfilled = migratePortfolios(config);
  for (const key of Object.keys(serverDefaults)) {
    if (!(key in config) && !API_KEY_FIELDS.includes(key)) {
      config[key] = serverDefaults[key];
      backfilled = true;
    }
  }
  return backfilled;
}

/**
 * Load config for `user` (a profile from services/auth.js) or, when null,
 * from localStorage — falling back to config.json defaults either way.
 *
 * A signed-in user with no saved settings yet (just registered) is seeded
 * from whatever this browser was already using, so signing up doesn't
 * throw away customizations made while anonymous.
 */
export async function loadConfig(user = null) {
  const serverDefaults = await fetchDefaults();

  let config;
  if (user) {
    if (user.settings) {
      config = JSON.parse(JSON.stringify(user.settings));
      if (backfill(config, serverDefaults)) config = adoptServerIds(config, config, await saveConfig(config, user)) ?? config;
    } else {
      config = readLocal() ?? { ...serverDefaults };
      backfill(config, serverDefaults);
      config = adoptServerIds(config, config, await saveConfig(config, user)) ?? config;
    }
  } else {
    config = readLocal();
    if (!config) {
      config = serverDefaults;
      await saveConfig(config);
    } else if (backfill(config, serverDefaults)) {
      await saveConfig(config);
    }
  }

  for (const field of API_KEY_FIELDS) config[field] = serverDefaults[field] ?? '';
  return config;
}

/**
 * Persist config to the signed-in user's profile, or to localStorage when
 * `user` is null. API keys are always excluded — they're fixed application
 * configuration, not something a visitor's save should be able to write.
 * Rejects if the server save fails.
 */
export async function saveConfig(config, user = null) {
  const toStore = withoutApiKeys(config);
  if (user) {
    // The saved settings come back — portfolio IDs may have been made unique (see adoptServerIds).
    return (await updateProfile({ settings: toStore }))?.settings ?? null;
  } else {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(toStore));
  }
}

/**
 * The server keeps portfolio IDs unique across accounts and may hand back
 * different ones than were sent (server/portfolioIds.js). Given what was
 * sent and what was saved, return `current` with those IDs swapped in (and
 * transfers pointed at them), or null when nothing changed.
 */
export function adoptServerIds(current, sent, saved) {
  const a = sent?.portfolios ?? [];
  const b = saved?.portfolios ?? [];
  const map = {};
  a.forEach((p, i) => { if (b[i] && p.id !== b[i].id) map[p.id] = b[i].id; });
  // A whole portfolio list where there wasn't one (an older settings file) — take it as saved.
  if (!Array.isArray(current?.portfolios) && Array.isArray(saved?.portfolios)) return { ...current, portfolios: saved.portfolios, transfers: saved.transfers };
  if (!Object.keys(map).length) return null;
  const fix = id => map[id] ?? id;
  return {
    ...current,
    portfolios: (current.portfolios ?? []).map(p => (p.id in map ? { ...p, id: map[p.id] } : p)),
    transfers: (current.transfers ?? []).map(t => ({ ...t, fromId: fix(t.fromId), toId: fix(t.toId) })),
  };
}

