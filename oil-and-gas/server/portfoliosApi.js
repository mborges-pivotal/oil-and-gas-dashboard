/**
 * /api/portfolios: IDs for new portfolios (see server/portfolioIds.js).
 *
 *   GET  /api/portfolios/id?name=…&id=…  → { id: suggestion, available? }
 *        (suggested ID for a name; with id, whether that exact ID is free)
 *   POST /api/portfolios/id   { name, id? } → 201 { id }   (claims it)
 *        409 { error, suggestion } when the requested id is taken or invalid
 *
 * The portfolio itself is saved with the user's settings; an ID claimed but
 * never saved is freed on the next settings save.
 */
const db = require('./db');
const { dispatch, requireUser, readJsonBody, sendJson, HttpError } = require('./auth');
const { suggestId, reserveId, isValidId } = require('./portfolioIds');

function portfolioName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'Portfolio name is required');
  const v = value.trim().replace(/\s+/g, ' ');
  if (v.length > 40) throw new HttpError(400, 'Portfolio name must be at most 40 characters');
  return v;
}

function check(req, res, reqUrl) {
  const userId = requireUser(req);
  const name = reqUrl.searchParams.get('name') ?? '';
  const id = reqUrl.searchParams.get('id');
  const out = { id: suggestId(name) };
  if (id) {
    const owner = isValidId(id) ? db.portfolioIdOwner(id) : -1;
    out.available = owner === null || owner === userId;
    out.valid = isValidId(id);
  }
  sendJson(res, 200, out);
}

async function claim(req, res) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  const result = reserveId(userId, portfolioName(body.name), body.id);
  if (result.error) {
    sendJson(res, 409, result);
    return;
  }
  sendJson(res, 201, { id: result.id });
}

async function handlePortfoliosApi(req, res, reqUrl) {
  const path = reqUrl.pathname.replace(/\/+$/, '');
  if (path === '/api/portfolios/id' && req.method === 'GET') return dispatch(req, res, reqUrl, (rq, rs) => check(rq, rs, reqUrl));
  if (path === '/api/portfolios/id' && req.method === 'POST') return dispatch(req, res, reqUrl, claim);
  sendJson(res, 404, { error: 'Not found' });
}

module.exports = { handlePortfoliosApi };
