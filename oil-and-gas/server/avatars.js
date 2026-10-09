/**
 * Profile avatars. Every account has a preset — an emoji on a colored circle
 * (a random one for new users) — and can upload a photo, which is shown
 * instead while it's set. Photos arrive from the browser already cropped
 * square and shrunk (PNG/JPEG/WebP, at most 200 KB) and are stored as a data
 * URL; they're served by an unguessable key so no user ID is exposed
 * (the Leaderboard shows other people's avatars).
 *
 *   PUT    /api/profile/avatar   { preset: { emoji, color } } | { image: 'data:image/…;base64,…' } → { user }
 *   DELETE /api/profile/avatar   (remove the photo; back to the preset) → { user }
 *   GET    /api/avatar/:key      the photo (signed in)
 */
const crypto = require('crypto');
const db = require('./db');
const { dispatch, requireUser, readJsonBody, sendJson, HttpError } = require('./auth');

// Mirrors utils/avatars.js. color = --series-N slot (1–8).
const EMOJIS = ['🦊', '🐻', '🐼', '🦉', '🐯', '🐸', '🐙', '🦁', '🐨', '🐧', '🦄', '🐳', '🐝', '🦋', '🐢', '🦜', '🐬', '🦒', '🦔', '🐿️', '🌵', '🌻', '🍀', '⚡', '🔥', '🛢️', '⛽', '🚀', '⭐', '🌙'];
const COLORS = [1, 2, 3, 4, 5, 6, 7, 8];
const MAX_IMAGE_BYTES = 200 * 1024;
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

const randomPreset = () => ({
  emoji: EMOJIS[crypto.randomInt(EMOJIS.length)],
  color: COLORS[crypto.randomInt(COLORS.length)],
});
const newKey = () => crypto.randomBytes(12).toString('base64url');

/** Give a user (new, or from before avatars) a random preset and an image key. */
function ensureAvatar(userId) {
  const p = db.getProfile(userId);
  if (!p) return;
  db.setAvatarKey(userId, newKey());
  db.setAvatarPreset(userId, randomPreset());
}
/** At startup: everyone without an avatar gets one. */
function assignMissingAvatars() {
  const ids = db.profilesWithoutAvatar();
  ids.forEach(ensureAvatar);
  return ids.length;
}

function validPreset(p) {
  if (!p || typeof p !== 'object') throw new HttpError(400, 'preset must be { emoji, color }');
  if (!EMOJIS.includes(p.emoji)) throw new HttpError(400, 'Unknown avatar emoji');
  const color = Number(p.color);
  if (!COLORS.includes(color)) throw new HttpError(400, 'Unknown avatar color');
  return { emoji: p.emoji, color };
}
function validImage(dataUrl) {
  const m = typeof dataUrl === 'string' ? IMAGE_RE.exec(dataUrl) : null;
  if (!m) throw new HttpError(400, 'The photo must be a PNG, JPEG or WebP image');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'The photo is too large (200 KB at most)');
  // Check the file really is the type it claims (magic numbers).
  const sig = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] }[m[1]];
  if (!sig.every((b, i) => bytes[i] === b)) throw new HttpError(400, "That file isn't a valid image");
  return dataUrl;
}

async function update(req, res) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  if (body.preset) db.setAvatarPreset(userId, validPreset(body.preset));
  else if (body.image) db.setAvatarImage(userId, validImage(body.image));
  else throw new HttpError(400, 'Send a preset or an image');
  require('./leaderboard').clearLeaderboardCache();
  sendJson(res, 200, { user: db.getProfile(userId) });
}

function removePhoto(req, res) {
  const userId = requireUser(req);
  db.clearAvatarImage(userId);
  require('./leaderboard').clearLeaderboardCache();
  sendJson(res, 200, { user: db.getProfile(userId) });
}

function serve(req, res, key) {
  requireUser(req);
  const dataUrl = db.avatarImageByKey(key);
  const m = dataUrl && IMAGE_RE.exec(dataUrl);
  if (!m) throw new HttpError(404, 'No such avatar');
  const bytes = Buffer.from(m[2], 'base64');
  // Versioned URLs (?v=…) — safe to cache for a long time in this browser.
  res.writeHead(200, { 'Content-Type': `image/${m[1]}`, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
}

async function handleAvatarApi(req, res, reqUrl) {
  const path = reqUrl.pathname.replace(/\/+$/, '');
  let m;
  if (path === '/api/profile/avatar' && req.method === 'PUT') return dispatch(req, res, reqUrl, update);
  if (path === '/api/profile/avatar' && req.method === 'DELETE') return dispatch(req, res, reqUrl, removePhoto);
  if ((m = path.match(/^\/api\/avatar\/([A-Za-z0-9_-]{8,40})$/)) && req.method === 'GET') return dispatch(req, res, reqUrl, (rq, rs) => serve(rq, rs, m[1]));
  sendJson(res, 404, { error: 'Not found' });
}

module.exports = { handleAvatarApi, ensureAvatar, assignMissingAvatars, EMOJIS, COLORS };
