/**
 * Client for the same-origin /api routes in server/auth.js — account
 * registration, sign-in/out, and the signed-in user's profile. The session
 * lives in an HttpOnly cookie the browser sends automatically; nothing
 * auth-related is ever stored in localStorage.
 */

// Shared with the other same-origin /api clients (services/watchlists.js).
export async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON (e.g. server not running the API) — handled below
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/** Current user's profile, or null when signed out (or no API available). */
export async function fetchCurrentUser() {
  try {
    return (await request('GET', '/api/auth/me')).user;
  } catch {
    return null;
  }
}

export async function register(email, password, displayName) {
  return (await request('POST', '/api/auth/register', { email, password, displayName })).user;
}

export async function login(email, password) {
  return (await request('POST', '/api/auth/login', { email, password })).user;
}

export async function logout() {
  await request('POST', '/api/auth/logout');
}

/** Partial update — pass any of { displayName, settings }. Returns the updated profile. */
export async function updateProfile(fields) {
  return (await request('PUT', '/api/profile', fields)).user;
}

export async function changePassword(currentPassword, newPassword) {
  await request('PUT', '/api/profile/password', { currentPassword, newPassword });
}
