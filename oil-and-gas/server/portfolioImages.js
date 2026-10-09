/**
 * Portfolio pictures (Account → Portfolios → a portfolio → Edit). The
 * browser sends a square, shrunk image (as for avatars); it's stored against
 * the portfolio's ID (only the portfolio's owner can set it) and served by an
 * unguessable key to anyone (the Leaderboard and portfolio profiles are public). The returned URL goes into the
 * portfolio's settings (portfolio.image) so cards can show it.
 *
 *   PUT    /api/portfolios/:id/image   { image: 'data:image/…;base64,…' } → { image: url }
 *   DELETE /api/portfolios/:id/image   → 204
 *   GET    /api/portfolio-image/:key   the picture
 */
const crypto = require('crypto');
const db = require('./db');
const { dispatch, requireUser, readJsonBody, sendJson, HttpError } = require('./auth');
const { validImage, IMAGE_RE } = require('./avatars');

function owned(userId, id) {
  if (db.portfolioIdOwner(id) !== userId) throw new HttpError(404, 'Portfolio not found');
}

async function setImage(req, res, id) {
  const userId = requireUser(req);
  owned(userId, id);
  const body = await readJsonBody(req);
  const url = db.setPortfolioImage(id, userId, validImage(body.image), crypto.randomBytes(12).toString('base64url'));
  sendJson(res, 200, { image: url });
}
function removeImage(req, res, id) {
  const userId = requireUser(req);
  owned(userId, id);
  db.deletePortfolioImage(id, userId);
  sendJson(res, 204);
}
function serve(req, res, key) {
  const dataUrl = db.portfolioImageByKey(key);
  const m = dataUrl && IMAGE_RE.exec(dataUrl);
  if (!m) throw new HttpError(404, 'No such image');
  const bytes = Buffer.from(m[2], 'base64');
  res.writeHead(200, { 'Content-Type': `image/${m[1]}`, 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
}

async function handlePortfolioImagesApi(req, res, reqUrl) {
  const path = reqUrl.pathname.replace(/\/+$/, '');
  let m;
  if ((m = path.match(/^\/api\/portfolios\/([a-z0-9-]{2,40})\/image$/))) {
    const id = m[1];
    if (req.method === 'PUT') return dispatch(req, res, reqUrl, (rq, rs) => setImage(rq, rs, id));
    if (req.method === 'DELETE') return dispatch(req, res, reqUrl, (rq, rs) => removeImage(rq, rs, id));
  }
  if ((m = path.match(/^\/api\/portfolio-image\/([A-Za-z0-9_-]{8,40})$/)) && req.method === 'GET') {
    return dispatch(req, res, reqUrl, (rq, rs) => serve(rq, rs, m[1]));
  }
  sendJson(res, 404, { error: 'Not found' });
}

module.exports = { handlePortfolioImagesApi };
