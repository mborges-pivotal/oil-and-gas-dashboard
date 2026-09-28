import { updateProfile } from '../services/auth.js';

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
  let backfilled = false;
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
      if (backfill(config, serverDefaults)) await saveConfig(config, user);
    } else {
      config = readLocal() ?? { ...serverDefaults };
      backfill(config, serverDefaults);
      await saveConfig(config, user);
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
    await updateProfile({ settings: toStore });
  } else {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(toStore));
  }
}

/**
 * Reset config to bundled defaults (for `user`'s profile, or this browser).
 */
export async function resetConfig(user = null) {
  if (!user) {
    localStorage.removeItem(CONFIG_KEY);
    return loadConfig();
  }
  const config = await fetchDefaults();
  await saveConfig(config, user);
  return config; // straight from config.json, so API keys are already injected
}

/**
 * Export config as a downloadable JSON file.
 */
export function exportConfig(config) {
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'oilgas-config.json';
  a.click();
  URL.revokeObjectURL(url);
}
