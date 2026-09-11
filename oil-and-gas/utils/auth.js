/**
 * Admin "login" for the Settings tab.
 *
 * IMPORTANT: this is a client-side-only gate, not real access control. This
 * app has no backend/database — the credential check runs entirely in JS
 * shipped to the browser, and the (hashed) credentials live in that same
 * browser's localStorage. Anyone with DevTools access to the page can read
 * the stored hash, call setSessionAuthed(true) directly, or just edit
 * localStorage — none of that requires knowing the password. Treat this as
 * a way to keep settings from being casually bumped on a shared screen, not
 * as protection against a motivated user.
 */

const CRED_KEY = 'oilgas_admin';            // { username, passwordHash } — kept out of config export/import
const SESSION_KEY = 'oilgas_admin_session'; // sessionStorage — cleared when the tab/browser closes

const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'admin';

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Returns { username, passwordHash }, seeding the default admin/admin on first use. */
export async function getCredentials() {
  const stored = localStorage.getItem(CRED_KEY);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      // corrupted — fall through and reseed defaults
    }
  }
  const defaults = { username: DEFAULT_USERNAME, passwordHash: await sha256(DEFAULT_PASSWORD) };
  localStorage.setItem(CRED_KEY, JSON.stringify(defaults));
  return defaults;
}

export async function verifyLogin(username, password) {
  const creds = await getCredentials();
  return username === creds.username && (await sha256(password)) === creds.passwordHash;
}

export async function updateCredentials(username, password) {
  const updated = { username, passwordHash: await sha256(password) };
  localStorage.setItem(CRED_KEY, JSON.stringify(updated));
  return updated;
}

export function isSessionAuthed() {
  return sessionStorage.getItem(SESSION_KEY) === '1';
}

export function setSessionAuthed(authed) {
  if (authed) {
    sessionStorage.setItem(SESSION_KEY, '1');
  } else {
    sessionStorage.removeItem(SESSION_KEY);
  }
}
