/**
 * Portfolio updates, following and discussion.
 *
 *  - An update (POST /api/posts) belongs to one of your portfolios: the
 *    trades it's about — action and ticker only, never amounts — plus an
 *    optional message. Private portfolio: only you see it (Inbox → Activity →
 *    You). Public: also everyone following the portfolio (→ Following).
 *  - Following a public portfolio shows its updates posted from then on.
 *    Only followers (and the author) can like and reply. If the portfolio
 *    goes private, its updates disappear from followers' feeds (visibility is
 *    checked on every read).
 *  - Forward is a link (copied in the browser) — nothing is sent to anyone.
 *
 *   GET    /api/portfolios/public?q=           public portfolios (Discover)
 *   POST   /api/portfolios/:id/follow          follow   DELETE … unfollow
 *   POST   /api/posts                          { portfolioId, trades: [{ action, symbol }], message }
 *   GET    /api/posts/:id                      one update (a forwarded link)
 *   DELETE /api/posts/:id                      (author)
 *   GET    /api/feed?tab=you|following&before=id
 *   GET    /api/feed/unread                    { you, following }
 *   POST   /api/feed/read                      { tab }
 *   POST   /api/posts/:id/like · DELETE …      (followers and the author)
 *   GET    /api/posts/:id/replies · POST …     { body } (followers and the author)
 *   DELETE /api/replies/:id                    (the reply's author or the post's author)
 */
const db = require('./db');
const { dispatch, requireUser, readJsonBody, sendJson, HttpError } = require('./auth');

const sql = () => db.raw();
const MAX_MESSAGE = 500;
const MAX_REPLY = 2000;
const MAX_TRADES = 20;
const MAX_POSTS_PER_DAY = 20;
const PAGE = 20;
const TICKER_RE = /^\^?[A-Z0-9][A-Z0-9.\-=]{0,19}$/;

// ── Portfolios, from everyone's settings (cached briefly; cleared on any settings save) ──
let pfCache = null;
function portfolioIndex() {
  if (pfCache && Date.now() - pfCache.at < 30000) return pfCache.map;
  const map = new Map();
  for (const { userId, settings } of db.profilesWithSettings()) {
    for (const pf of settings?.portfolios ?? []) {
      if (!pf?.id) continue;
      map.set(pf.id, {
        id: pf.id, name: pf.name, ownerId: userId, public: pf.visibility === 'public',
        image: typeof pf.image === 'string' && /^\/api\/portfolio-image\/[A-Za-z0-9_-]+(\?v=[^\s"]*)?$/.test(pf.image) ? pf.image : null,
      });
    }
  }
  pfCache = { at: Date.now(), map };
  return map;
}
function clearSocialCache() { pfCache = null; }
const ownerNames = new Map();
function ownerName(userId) {
  if (!ownerNames.has(userId)) ownerNames.set(userId, (db.getProfile(userId)?.displayName || '').trim() || 'Anonymous investor');
  return ownerNames.get(userId);
}
function clearNames() { ownerNames.clear(); }

const followRow = (userId, pid) => sql().prepare('SELECT created_at FROM portfolio_follows WHERE user_id = ? AND portfolio_id = ?').get(userId, pid);

/** Can `userId` see this post, and interact with it (like / reply)? */
function access(userId, post) {
  const pf = portfolioIndex().get(post.portfolio_id);
  if (!pf) return { see: false };
  if (post.user_id === userId) return { see: true, interact: true };
  if (!pf.public) return { see: false };
  const f = followRow(userId, post.portfolio_id);
  // Following shows posts from the follow on; a forwarded link can show any public post (read-only).
  return { see: true, interact: !!f, following: !!f };
}

function postOut(userId, row) {
  const pf = portfolioIndex().get(row.portfolio_id);
  const counts = sql().prepare(`SELECT
      (SELECT COUNT(*) FROM post_likes WHERE post_id = ?) AS likes,
      (SELECT COUNT(*) FROM post_replies WHERE post_id = ?) AS replies,
      (SELECT COUNT(*) FROM post_likes WHERE post_id = ? AND user_id = ?) AS mine`).get(row.id, row.id, row.id, userId);
  const a = access(userId, row);
  return {
    id: row.id,
    trades: JSON.parse(row.trades),
    message: row.message,
    createdAt: row.created_at.replace(' ', 'T') + 'Z',
    portfolio: { id: row.portfolio_id, name: pf?.name ?? row.portfolio_id, image: pf?.image ?? null, public: !!pf?.public },
    owner: ownerName(row.user_id),
    mine: row.user_id === userId,
    likes: counts.likes, replies: counts.replies, liked: !!counts.mine,
    canInteract: !!a.interact, following: !!a.following,
  };
}

function getPost(userId, id) {
  const row = sql().prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Update not found');
  const a = access(userId, row);
  if (!a.see) throw new HttpError(404, 'Update not found');
  return { row, a };
}
const parseId = raw => {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(404, 'Not found');
  return n;
};

// ── Discover ──
async function discover(req, res, reqUrl) {
  const userId = requireUser(req);
  const q = (reqUrl.searchParams.get('q') || '').trim().toLowerCase().replace(/^@/, '');
  const list = [...portfolioIndex().values()].filter(p => p.public);
  // All-Time returns from the leaderboard (same numbers as there).
  let returns = new Map();
  try {
    const board = await require('./leaderboard').getBoard('all');
    returns = new Map(board.rows.map(r => [r.portfolioId, r.returnPct]));
  } catch { /* returns unavailable */ }
  const followers = new Map(sql().prepare('SELECT portfolio_id, COUNT(*) AS n FROM portfolio_follows GROUP BY portfolio_id').all().map(r => [r.portfolio_id, r.n]));
  const mineFollowing = new Set(sql().prepare('SELECT portfolio_id FROM portfolio_follows WHERE user_id = ?').all(userId).map(r => r.portfolio_id));
  const rows = list
    .map(p => ({
      id: p.id, name: p.name, image: p.image, owner: ownerName(p.ownerId), mine: p.ownerId === userId,
      returnPct: returns.get(p.id) ?? null, followers: followers.get(p.id) ?? 0, following: mineFollowing.has(p.id),
    }))
    .filter(p => !q || p.name.toLowerCase().includes(q) || p.id.includes(q) || p.owner.toLowerCase().includes(q))
    .sort((a, b) => (b.returnPct ?? -Infinity) - (a.returnPct ?? -Infinity) || a.name.localeCompare(b.name))
    .slice(0, 50);
  sendJson(res, 200, { portfolios: rows });
}

function follow(req, res, pid, on) {
  const userId = requireUser(req);
  const pf = portfolioIndex().get(pid);
  if (on) {
    if (!pf || !pf.public) throw new HttpError(404, 'Portfolio not found');
    if (pf.ownerId === userId) throw new HttpError(400, "That's your own portfolio");
    sql().prepare("INSERT OR IGNORE INTO portfolio_follows (user_id, portfolio_id) VALUES (?, ?)").run(userId, pid);
  } else {
    sql().prepare('DELETE FROM portfolio_follows WHERE user_id = ? AND portfolio_id = ?').run(userId, pid);
  }
  const n = sql().prepare('SELECT COUNT(*) AS n FROM portfolio_follows WHERE portfolio_id = ?').get(pid).n;
  sendJson(res, 200, { following: on, followers: n });
}

// ── Posts ──
async function createPost(req, res) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  const pid = typeof body.portfolioId === 'string' ? body.portfolioId : '';
  if (db.portfolioIdOwner(pid) !== userId || !portfolioIndex().get(pid)) {
    clearSocialCache(); // a portfolio created moments ago
    if (db.portfolioIdOwner(pid) !== userId || !portfolioIndex().get(pid)) throw new HttpError(400, 'Pick one of your portfolios');
  }
  if (!Array.isArray(body.trades) || !body.trades.length) throw new HttpError(400, 'Pick at least one buy or sell');
  if (body.trades.length > MAX_TRADES) throw new HttpError(400, `At most ${MAX_TRADES} trades in one update`);
  const trades = body.trades.map(t => {
    const action = t?.action === 'sell' ? 'sell' : t?.action === 'buy' ? 'buy' : null;
    const symbol = typeof t?.symbol === 'string' ? t.symbol.trim().toUpperCase() : '';
    if (!action || !TICKER_RE.test(symbol)) throw new HttpError(400, 'Each trade needs buy/sell and a ticker');
    return { action, symbol };
  });
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message.length > MAX_MESSAGE) throw new HttpError(400, `The message can be at most ${MAX_MESSAGE} characters`);
  const today = sql().prepare("SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND created_at > datetime('now', '-1 day')").get(userId).n;
  if (today >= MAX_POSTS_PER_DAY) throw new HttpError(429, `You can post ${MAX_POSTS_PER_DAY} updates a day`);
  const { lastInsertRowid } = sql().prepare('INSERT INTO posts (user_id, portfolio_id, trades, message) VALUES (?, ?, ?, ?)').run(userId, pid, JSON.stringify(trades), message);
  const row = sql().prepare('SELECT * FROM posts WHERE id = ?').get(Number(lastInsertRowid));
  sendJson(res, 201, { post: postOut(userId, row) });
}

function readPost(req, res, id) {
  const userId = requireUser(req);
  const { row } = getPost(userId, id);
  sendJson(res, 200, { post: postOut(userId, row) });
}

function deletePost(req, res, id) {
  const userId = requireUser(req);
  const n = sql().prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(id, userId).changes;
  if (!n) throw new HttpError(404, 'Update not found');
  sendJson(res, 204);
}

function feed(req, res, reqUrl) {
  const userId = requireUser(req);
  const tab = reqUrl.searchParams.get('tab') === 'following' ? 'following' : 'you';
  const before = Number(reqUrl.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
  let rows;
  if (tab === 'you') {
    rows = sql().prepare('SELECT * FROM posts WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(userId, before, PAGE + 1);
  } else {
    const index = portfolioIndex();
    const publicIds = [...index.values()].filter(p => p.public).map(p => p.id);
    rows = sql().prepare(`SELECT p.* FROM posts p JOIN portfolio_follows f ON f.portfolio_id = p.portfolio_id AND f.user_id = ?
      WHERE p.created_at >= f.created_at AND p.user_id != ? AND p.id < ? ORDER BY p.id DESC LIMIT 200`).all(userId, userId, before)
      .filter(r => publicIds.includes(r.portfolio_id)).slice(0, PAGE + 1);
  }
  const more = rows.length > PAGE;
  sendJson(res, 200, { tab, posts: rows.slice(0, PAGE).map(r => postOut(userId, r)), more });
}

function readAt(userId, tab) {
  return sql().prepare('SELECT read_at FROM feed_reads WHERE user_id = ? AND tab = ?').get(userId, tab)?.read_at ?? '1970-01-01 00:00:00';
}
/** You: likes and replies by others on your updates since you last looked. Following: new updates. */
function unreadCounts(userId) {
  const youAt = readAt(userId, 'you');
  const you = sql().prepare(`SELECT
      (SELECT COUNT(*) FROM post_likes l JOIN posts p ON p.id = l.post_id WHERE p.user_id = ? AND l.user_id != ? AND l.created_at > ?) +
      (SELECT COUNT(*) FROM post_replies r JOIN posts p ON p.id = r.post_id WHERE p.user_id = ? AND r.user_id != ? AND r.created_at > ?) AS n`)
    .get(userId, userId, youAt, userId, userId, youAt).n;
  const fAt = readAt(userId, 'following');
  const publicIds = new Set([...portfolioIndex().values()].filter(p => p.public).map(p => p.id));
  const following = sql().prepare(`SELECT p.portfolio_id FROM posts p JOIN portfolio_follows f ON f.portfolio_id = p.portfolio_id AND f.user_id = ?
      WHERE p.created_at >= f.created_at AND p.user_id != ? AND p.created_at > ?`).all(userId, userId, fAt)
    .filter(r => publicIds.has(r.portfolio_id)).length;
  return { you, following };
}
function unread(req, res) {
  sendJson(res, 200, unreadCounts(requireUser(req)));
}
async function markRead(req, res) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  const tab = body.tab === 'following' ? 'following' : 'you';
  sql().prepare("INSERT INTO feed_reads (user_id, tab, read_at) VALUES (?, ?, datetime('now')) ON CONFLICT(user_id, tab) DO UPDATE SET read_at = excluded.read_at").run(userId, tab);
  sendJson(res, 200, unreadCounts(userId));
}

// ── Likes and replies (followers and the author) ──
function interactable(userId, id) {
  const { row, a } = getPost(userId, id);
  if (!a.interact) throw new HttpError(403, `Follow @${row.portfolio_id} to like and reply`);
  return row;
}
function like(req, res, id, on) {
  const userId = requireUser(req);
  const row = interactable(userId, id);
  if (on) sql().prepare('INSERT OR IGNORE INTO post_likes (post_id, user_id) VALUES (?, ?)').run(id, userId);
  else sql().prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(id, userId);
  sendJson(res, 200, { post: postOut(userId, row) });
}
function replyOut(userId, r, postOwnerId) {
  return {
    id: r.id, body: r.body, createdAt: r.created_at.replace(' ', 'T') + 'Z', author: ownerName(r.user_id),
    avatar: db.getProfile(r.user_id)?.avatar ?? null,
    mine: r.user_id === userId, canDelete: r.user_id === userId || postOwnerId === userId, byOwner: r.user_id === postOwnerId,
  };
}
function listReplies(req, res, id) {
  const userId = requireUser(req);
  const { row } = getPost(userId, id);
  const replies = sql().prepare('SELECT * FROM post_replies WHERE post_id = ? ORDER BY id').all(id).map(r => replyOut(userId, r, row.user_id));
  sendJson(res, 200, { replies });
}
async function addReply(req, res, id) {
  const userId = requireUser(req);
  const row = interactable(userId, id);
  const body = await readJsonBody(req);
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) throw new HttpError(400, 'Write a reply');
  if (text.length > MAX_REPLY) throw new HttpError(400, `A reply can be at most ${MAX_REPLY} characters`);
  const { lastInsertRowid } = sql().prepare('INSERT INTO post_replies (post_id, user_id, body) VALUES (?, ?, ?)').run(id, userId, text);
  const r = sql().prepare('SELECT * FROM post_replies WHERE id = ?').get(Number(lastInsertRowid));
  sendJson(res, 201, { reply: replyOut(userId, r, row.user_id), post: postOut(userId, row) });
}
function deleteReply(req, res, id) {
  const userId = requireUser(req);
  const r = sql().prepare('SELECT r.*, p.user_id AS post_owner FROM post_replies r JOIN posts p ON p.id = r.post_id WHERE r.id = ?').get(id);
  if (!r || (r.user_id !== userId && r.post_owner !== userId)) throw new HttpError(404, 'Reply not found');
  sql().prepare('DELETE FROM post_replies WHERE id = ?').run(id);
  sendJson(res, 204);
}

async function handleSocialApi(req, res, reqUrl) {
  const path = reqUrl.pathname.replace(/\/+$/, '');
  const M = req.method;
  let m;
  const run = h => dispatch(req, res, reqUrl, h);
  if (path === '/api/portfolios/public' && M === 'GET') return run((rq, rs) => discover(rq, rs, reqUrl));
  if ((m = path.match(/^\/api\/portfolios\/([a-z0-9-]{2,40})\/follow$/)) && (M === 'POST' || M === 'DELETE')) return run((rq, rs) => follow(rq, rs, m[1], M === 'POST'));
  if (path === '/api/posts' && M === 'POST') return run(createPost);
  if ((m = path.match(/^\/api\/posts\/(\d+)$/))) {
    if (M === 'GET') return run((rq, rs) => readPost(rq, rs, parseId(m[1])));
    if (M === 'DELETE') return run((rq, rs) => deletePost(rq, rs, parseId(m[1])));
  }
  if ((m = path.match(/^\/api\/posts\/(\d+)\/like$/)) && (M === 'POST' || M === 'DELETE')) return run((rq, rs) => like(rq, rs, parseId(m[1]), M === 'POST'));
  if ((m = path.match(/^\/api\/posts\/(\d+)\/replies$/))) {
    if (M === 'GET') return run((rq, rs) => listReplies(rq, rs, parseId(m[1])));
    if (M === 'POST') return run((rq, rs) => addReply(rq, rs, parseId(m[1])));
  }
  if ((m = path.match(/^\/api\/replies\/(\d+)$/)) && M === 'DELETE') return run((rq, rs) => deleteReply(rq, rs, parseId(m[1])));
  if (path === '/api/feed' && M === 'GET') return run((rq, rs) => feed(rq, rs, reqUrl));
  if (path === '/api/feed/unread' && M === 'GET') return run(unread);
  if (path === '/api/feed/read' && M === 'POST') return run(markRead);
  sendJson(res, 404, { error: 'Not found' });
}

const SOCIAL_PATH = /^\/api\/(posts|replies|feed)(\/|$)|^\/api\/portfolios\/(public$|[a-z0-9-]{2,40}\/follow$)/;
module.exports = { handleSocialApi, clearSocialCache, clearNames, SOCIAL_PATH };
