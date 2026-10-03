/**
 * Client for /api/watchlists (server/watchlists.js) — a signed-in user's
 * additional stock watchlists. Each is { id, name, tickers, createdAt,
 * updatedAt }. The default watchlist isn't here; it's config.stocks.tickers.
 */
import { request } from './auth.js';

export async function fetchWatchlists() {
  return (await request('GET', '/api/watchlists')).watchlists;
}

export async function createWatchlist(name, tickers = []) {
  return (await request('POST', '/api/watchlists', { name, tickers })).watchlist;
}

/** Partial update — pass any of { name, tickers }. Returns the updated list. */
export async function updateWatchlist(id, fields) {
  return (await request('PUT', `/api/watchlists/${encodeURIComponent(id)}`, fields)).watchlist;
}

export async function deleteWatchlist(id) {
  await request('DELETE', `/api/watchlists/${encodeURIComponent(id)}`);
}
