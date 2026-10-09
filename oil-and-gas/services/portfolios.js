/** Client for /api/portfolios (server/portfoliosApi.js) — IDs for new portfolios, unique across accounts. */
import { request } from './auth.js';

/** → { id: suggestion for the name, available?, valid? } (available/valid when `id` is given) */
export async function suggestPortfolioId(name, id) {
  const q = new URLSearchParams({ name: name ?? '' });
  if (id) q.set('id', id);
  return request('GET', `/api/portfolios/id?${q}`);
}

/** Claim an ID: exactly `id` when given, else one derived from the name → id. Throws (with .suggestion) when taken. */
export async function claimPortfolioId(name, id) {
  const res = await fetch('/api/portfolios/id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify(id ? { name, id } : { name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.suggestion = body.suggestion ?? null;
    throw err;
  }
  return body.id;
}

/** Set a portfolio's picture (a square data URL) → its URL, to keep on the portfolio. */
export async function setPortfolioImage(id, image) {
  return (await request('PUT', `/api/portfolios/${encodeURIComponent(id)}/image`, { image })).image;
}
export async function removePortfolioImage(id) {
  await request('DELETE', `/api/portfolios/${encodeURIComponent(id)}/image`);
}
