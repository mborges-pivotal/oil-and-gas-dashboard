const CONFIG_KEY = 'oilgas_config';

/**
 * Load config from localStorage, falling back to config.json defaults.
 * Returns a plain object (deep clone so mutations don't corrupt the cache).
 */
export async function loadConfig() {
  const stored = localStorage.getItem(CONFIG_KEY);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      // corrupted — fall through to defaults
    }
  }
  // Fetch defaults from bundled config.json
  const res = await fetch('./config.json');
  const defaults = await res.json();
  saveConfig(defaults);
  return defaults;
}

/**
 * Persist config to localStorage.
 */
export function saveConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
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
