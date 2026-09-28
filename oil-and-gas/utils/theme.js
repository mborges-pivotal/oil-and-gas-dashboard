/**
 * UI theme: 'dark' | 'light' | 'system' (follow the OS setting, live).
 *
 * The preference itself is part of the dashboard config (config.ui.theme),
 * so it's saved to the user's profile when signed in, like every other
 * setting. It's also mirrored to localStorage under THEME_CACHE_KEY purely
 * so the inline script in index.html can paint the right theme before the
 * app (and a signed-in user's profile) has loaded — no dark→light flash.
 *
 * styles.css keys its palettes off <html data-theme="dark|light">, which
 * is always the *resolved* theme — 'system' never reaches the CSS.
 */

export const THEME_OPTIONS = [
  { value: 'light',  label: 'Light',  icon: '☀' },
  { value: 'dark',   label: 'Dark',   icon: '☾' },
  { value: 'system', label: 'System', icon: '◐' },
];
const VALID = new Set(THEME_OPTIONS.map((o) => o.value));
const THEME_CACHE_KEY = 'oilgas_theme'; // keep in sync with index.html

const systemLight = window.matchMedia('(prefers-color-scheme: light)');
let preference = 'system';

export function normalizeTheme(value) {
  return VALID.has(value) ? value : 'system';
}

function resolve(pref) {
  if (pref === 'system') return systemLight.matches ? 'light' : 'dark';
  return pref;
}

/** Apply a theme preference to the page and remember it for first paint. */
export function applyTheme(pref) {
  preference = normalizeTheme(pref);
  document.documentElement.dataset.theme = resolve(preference);
  try {
    localStorage.setItem(THEME_CACHE_KEY, preference);
  } catch {
    // storage unavailable (private mode etc.) — only costs the first-paint hint
  }
}

// While following the system, track OS light/dark switches live.
systemLight.addEventListener('change', () => {
  if (preference === 'system') applyTheme('system');
});
