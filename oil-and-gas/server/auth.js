/**
 * /api/* routes: registration, login/logout, and the signed-in user's
 * profile (display name, password, dashboard settings).
 *
 * Sessions are an opaque random token in an HttpOnly, SameSite=Lax cookie;
 * only its SHA-256 is stored server-side (see db.js). Passwords are hashed
 * with scrypt from node:crypto — still no npm dependencies.
 *
 * CSRF: mutating routes only accept `Content-Type: application/json`, which
 * a cross-site <form> can't send and a cross-site fetch() can't send without
 * a CORS preflight (which /api never approves). Combined with SameSite=Lax,
 * that's enough for a same-origin SPA.
 */

const crypto = require('crypto');
const db = require('./db');

const COOKIE_NAME = 'oilgas_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_BODY_BYTES = 256 * 1024;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const MAX_DISPLAY_NAME_LENGTH = 80;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Fixed, operator-configured values (see server.js) — never stored per user.
const API_KEY_FIELDS = ['eiaApiKey', 'fredApiKey'];

// ── Password hashing ──────────────────────────────────────────────────────
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N, r, p }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, N, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), {
    N: Number(N), r: Number(r), p: Number(p), keylen: expected.length,
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Verified against when the email doesn't exist, so a login attempt takes
// the same time whether or not the account is registered.
const DUMMY_HASH_PROMISE = hashPassword(crypto.randomBytes(16).toString('hex'));

// ── Rate limiting (login/register) ────────────────────────────────────────
// In-memory, per client IP: fine for a single-process deployment.
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 20;
const attempts = new Map(); // ip -> { count, resetAt }

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

function rateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let entry = attempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    attempts.set(ip, entry);
  }
  entry.count++;
  return entry.count > RATE_MAX_ATTEMPTS;
}

// Housekeeping: drop stale rate-limit entries and expired sessions hourly.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) if (entry.resetAt <= now) attempts.delete(ip);
  db.deleteExpiredSessions();
}, 60 * 60 * 1000).unref();

// ── Sessions / cookies ────────────────────────────────────────────────────
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(req, res, token, maxAgeSeconds) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.createSession(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  setSessionCookie(req, res, token, SESSION_TTL_MS / 1000);
}

function currentTokenHash(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  return token ? sha256(token) : null;
}

function currentUserId(req) {
  const tokenHash = currentTokenHash(req);
  return tokenHash ? db.getSessionUserId(tokenHash) : null;
}

// ── Request/response helpers ──────────────────────────────────────────────
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readJsonBody(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    return Promise.reject(new HttpError(415, 'Expected application/json'));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Keep draining (but discarding) so the 413 response still gets
        // delivered instead of the socket being torn down mid-request.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          throw new Error();
        }
        resolve(body);
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function requireUser(req) {
  const userId = currentUserId(req);
  if (!userId) throw new HttpError(401, 'Not signed in');
  return userId;
}

function validateEmail(email) {
  if (typeof email !== 'string') throw new HttpError(400, 'Email is required');
  const trimmed = email.trim();
  if (trimmed.length > 254 || !EMAIL_RE.test(trimmed)) throw new HttpError(400, 'Enter a valid email address');
  return trimmed;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) throw new HttpError(400, 'Password is too long');
  return password;
}

function validateDisplayName(name) {
  if (name == null) return '';
  if (typeof name !== 'string') throw new HttpError(400, 'Display name must be text');
  const trimmed = name.trim();
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new HttpError(400, `Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`);
  }
  return trimmed;
}

function validateSettings(settings) {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new HttpError(400, 'Settings must be an object');
  }
  const clean = { ...settings };
  for (const field of API_KEY_FIELDS) delete clean[field];
  return clean;
}

// ── Route handlers ────────────────────────────────────────────────────────
async function register(req, res) {
  if (rateLimited(req)) throw new HttpError(429, 'Too many attempts — try again in a few minutes');
  const body = await readJsonBody(req);
  const email = validateEmail(body.email);
  const password = validatePassword(body.password);
  const displayName = validateDisplayName(body.displayName);

  if (db.findUserByEmail(email)) throw new HttpError(409, 'An account with that email already exists');

  let userId;
  try {
    userId = db.createUser(email, await hashPassword(password), displayName);
  } catch (err) {
    // Lost a race with a concurrent registration for the same email
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'An account with that email already exists');
    throw err;
  }
  startSession(req, res, userId);
  sendJson(res, 201, { user: db.getProfile(userId) });
}

async function login(req, res) {
  if (rateLimited(req)) throw new HttpError(429, 'Too many attempts — try again in a few minutes');
  const body = await readJsonBody(req);
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const user = email ? db.findUserByEmail(email) : null;
  const ok = await verifyPassword(password, user ? user.password_hash : await DUMMY_HASH_PROMISE);
  if (!user || !ok) throw new HttpError(401, 'Incorrect email or password');

  startSession(req, res, user.id);
  sendJson(res, 200, { user: db.getProfile(user.id) });
}

function logout(req, res) {
  const tokenHash = currentTokenHash(req);
  if (tokenHash) db.deleteSession(tokenHash);
  setSessionCookie(req, res, '', 0);
  sendJson(res, 204);
}

// Returns { user: null } rather than 401 when signed out — the SPA calls
// this on every load, and being signed out is a normal state, not an error.
function me(req, res) {
  const userId = currentUserId(req);
  sendJson(res, 200, { user: userId ? db.getProfile(userId) : null });
}

async function updateProfile(req, res) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  if ('displayName' in body) db.updateDisplayName(userId, validateDisplayName(body.displayName));
  if ('settings' in body) {
    const settings = validateSettings(body.settings);
    // Portfolio IDs must be unique across accounts — fix any that aren't (the
    // response carries the result, so the client adopts the new IDs).
    require('./portfolioIds').normalizeSettings(userId, settings);
    db.updateSettings(userId, settings);
    require('./leaderboard').clearLeaderboardCache(); // visibility or positions may have changed
  }
  sendJson(res, 200, { user: db.getProfile(userId) });
}

async function changePassword(req, res) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  const user = db.findUserById(userId);
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  if (!(await verifyPassword(current, user.password_hash))) {
    throw new HttpError(400, 'Current password is incorrect');
  }
  db.updatePassword(userId, await hashPassword(validatePassword(body.newPassword)));
  // Sign out every other device; keep this one signed in.
  db.deleteOtherSessions(userId, currentTokenHash(req));
  sendJson(res, 204);
}

const ROUTES = {
  'POST /api/auth/register': register,
  'POST /api/auth/login': login,
  'POST /api/auth/logout': logout,
  'GET /api/auth/me': me,
  'GET /api/profile': (req, res) => sendJson(res, 200, { user: db.getProfile(requireUser(req)) }),
  'PUT /api/profile': updateProfile,
  'PUT /api/profile/password': changePassword,
};

async function handleApi(req, res, reqUrl) {
  const handler = ROUTES[`${req.method} ${reqUrl.pathname}`];
  if (!handler) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  await dispatch(req, res, reqUrl, handler);
}

// Runs a route handler, turning HttpErrors into JSON error responses.
// Shared with other /api modules (server/watchlists.js).
async function dispatch(req, res, reqUrl, handler) {
  try {
    await handler(req, res);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
    } else {
      console.error(`${req.method} ${reqUrl.pathname} failed:`, err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    }
  }
}

module.exports = { handleApi, dispatch, requireUser, readJsonBody, sendJson, HttpError };
