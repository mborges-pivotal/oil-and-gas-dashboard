const CONFIG_KEY = 'oilgas_config';

// eiaApiKey/fredApiKey are fixed, operator-configured application settings
// (see server.js, which injects them from EIA_API_KEY/FRED_API_KEY env
// vars) — never user-editable, never persisted to localStorage. Every
// loadConfig() call re-fetches config.json to pick up their current value,
// even when the rest of the config already lives in localStorage.
const API_KEY_FIELDS = ['eiaApiKey', 'fredApiKey'];

/**
 * Load config from localStorage, falling back to config.json defaults.
 * Returns a plain object (deep clone so mutations don't corrupt the cache).
 */
export async function loadConfig() {
  const res = await fetch('./config.json', { cache: 'no-store' });
  const serverDefaults = await res.json();

  let config = null;
  const stored = localStorage.getItem(CONFIG_KEY);
  if (stored) {
    try {
      config = JSON.parse(stored);
    } catch {
      // corrupted — fall through to defaults
    }
  }

  if (!config) {
    config = serverDefaults;
    saveConfig(config);
  } else {
    // A returning visitor's stored config predates any top-level section
    // added to config.json since they first saved — e.g. a new tab's
    // config shipped after they'd already been using the app. Backfill
    // only what's entirely missing (never touch a key they already have,
    // even if its value differs from the current default) and persist the
    // backfill so this only has to run once per new field.
    let backfilled = false;
    for (const key of Object.keys(serverDefaults)) {
      if (!(key in config) && !API_KEY_FIELDS.includes(key)) {
        config[key] = serverDefaults[key];
        backfilled = true;
      }
    }
    if (backfilled) saveConfig(config);
  }

  for (const field of API_KEY_FIELDS) config[field] = serverDefaults[field] ?? '';
  return config;
}

/**
 * Persist config to localStorage. API keys are always excluded — they're
 * fixed application configuration, not something a visitor's save should
 * be able to write.
 */
export function saveConfig(config) {
  const toStore = { ...config };
  for (const field of API_KEY_FIELDS) delete toStore[field];
  localStorage.setItem(CONFIG_KEY, JSON.stringify(toStore));
}

/**
 * Reset config to bundled defaults.
 */
export async function resetConfig() {
  localStorage.removeItem(CONFIG_KEY);
  return loadConfig();
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
