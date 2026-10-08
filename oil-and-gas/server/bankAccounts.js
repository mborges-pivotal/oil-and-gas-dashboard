/**
 * /api/bank-accounts routes: a signed-in user's external bank accounts
 * (Profile → Bank accounts) — where deposits into the account's cash come
 * from. Only the last 4 digits of an account number are stored; nothing is
 * verified with the bank yet, so "connected" is the user's own setting.
 *
 *   GET    /api/bank-accounts          → { bankAccounts }
 *   POST   /api/bank-accounts          { bank, accountNumber, type, status? } → 201 { bankAccount }
 *   PUT    /api/bank-accounts/:id      { bank?, type?, status? } → { bankAccount }
 *   DELETE /api/bank-accounts/:id      → 204
 *
 * type: checking | savings | investments; status: connected | disconnected.
 */
const db = require('./db');
const { dispatch, requireUser, readJsonBody, sendJson, HttpError } = require('./auth');

const MAX_ACCOUNTS = 20;
const TYPES = ['checking', 'savings', 'investments'];
const STATUSES = ['connected', 'disconnected'];

function bankName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'Bank name is required');
  const v = value.trim().replace(/\s+/g, ' ');
  if (v.length > 60) throw new HttpError(400, 'Bank name must be at most 60 characters');
  return v;
}
function last4Of(value) {
  const digits = String(value ?? '').replace(/[\s-]/g, '');
  if (!/^\d{4,17}$/.test(digits)) throw new HttpError(400, 'Account number must be 4 to 17 digits');
  return digits.slice(-4);
}
function oneOf(value, field, options) {
  if (!options.includes(value)) throw new HttpError(400, `${field} must be one of: ${options.join(', ')}`);
  return value;
}
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, 'Bank account not found');
  return id;
}

function list(req, res) {
  sendJson(res, 200, { bankAccounts: db.listBankAccounts(requireUser(req)) });
}

async function create(req, res) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  const account = {
    bank: bankName(body.bank),
    last4: last4Of(body.accountNumber),
    type: oneOf(body.type ?? 'checking', 'type', TYPES),
    status: oneOf(body.status ?? 'connected', 'status', STATUSES),
  };
  if (db.countBankAccounts(userId) >= MAX_ACCOUNTS) throw new HttpError(400, `You can add at most ${MAX_ACCOUNTS} bank accounts`);
  const id = db.createBankAccount(userId, account);
  sendJson(res, 201, { bankAccount: db.getBankAccount(userId, id) });
}

async function update(req, res, id) {
  const userId = requireUser(req);
  const body = await readJsonBody(req);
  const cur = db.getBankAccount(userId, id);
  if (!cur) throw new HttpError(404, 'Bank account not found');
  if ('accountNumber' in body) throw new HttpError(400, "An account's number can't be changed — add it as a new account");
  db.updateBankAccount(userId, id, {
    bank: 'bank' in body ? bankName(body.bank) : cur.bank,
    type: 'type' in body ? oneOf(body.type, 'type', TYPES) : cur.type,
    status: 'status' in body ? oneOf(body.status, 'status', STATUSES) : cur.status,
  });
  sendJson(res, 200, { bankAccount: db.getBankAccount(userId, id) });
}

function remove(req, res, id) {
  if (!db.deleteBankAccount(requireUser(req), id)) throw new HttpError(404, 'Bank account not found');
  sendJson(res, 204);
}

async function handleBankAccountsApi(req, res, reqUrl) {
  const path = reqUrl.pathname.replace(/\/+$/, '');
  let handler = null;
  let m;
  if (path === '/api/bank-accounts') {
    if (req.method === 'GET') handler = list;
    else if (req.method === 'POST') handler = create;
  } else if ((m = path.match(/^\/api\/bank-accounts\/([^/]+)$/))) {
    if (req.method === 'PUT') handler = (rq, rs) => update(rq, rs, parseId(m[1]));
    else if (req.method === 'DELETE') handler = (rq, rs) => remove(rq, rs, parseId(m[1]));
  }
  if (!handler) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  await dispatch(req, res, reqUrl, handler);
}

module.exports = { handleBankAccountsApi };
