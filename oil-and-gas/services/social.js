/** Client for the social API (server/social.js): updates, following, likes and replies. */
import { request } from './auth.js';

const enc = encodeURIComponent;

/** Public portfolios (Discover), best All-Time return first; `q` searches name, @id and owner. */
export async function searchPublicPortfolios(q) {
  return (await request('GET', `/api/portfolios/public?${new URLSearchParams({ q: q ?? '' })}`)).portfolios;
}
/** → { following, followers } */
export async function setFollowing(portfolioId, on) {
  return request(on ? 'POST' : 'DELETE', `/api/portfolios/${enc(portfolioId)}/follow`);
}

/** Share an update: trades are [{ action: 'buy'|'sell', symbol }] — no amounts. */
export async function createPost(portfolioId, trades, message) {
  return (await request('POST', '/api/posts', { portfolioId, trades, message })).post;
}
export async function fetchPost(id) {
  return (await request('GET', `/api/posts/${enc(id)}`)).post;
}
export async function deletePost(id) {
  await request('DELETE', `/api/posts/${enc(id)}`);
}
/** tab: 'you' | 'following' → { posts, more } (older pages with `before` = the last id). */
export async function fetchFeed(tab, before) {
  const q = new URLSearchParams({ tab });
  if (before) q.set('before', before);
  return request('GET', `/api/feed?${q}`);
}
export async function fetchUnread() {
  return request('GET', '/api/feed/unread');
}
export async function markFeedRead(tab) {
  return request('POST', '/api/feed/read', { tab });
}

export async function setLiked(postId, on) {
  return (await request(on ? 'POST' : 'DELETE', `/api/posts/${enc(postId)}/like`)).post;
}
export async function fetchReplies(postId) {
  return (await request('GET', `/api/posts/${enc(postId)}/replies`)).replies;
}
/** → { reply, post } */
export async function addReply(postId, body) {
  return request('POST', `/api/posts/${enc(postId)}/replies`, { body });
}
export async function deleteReply(id) {
  await request('DELETE', `/api/replies/${enc(id)}`);
}

/** Forward = a link to share yourself (nothing is sent to anyone). copyText → true when copied; else the link is shown to copy by hand. */
export function shareLink(hash) {
  return `${location.origin}${location.pathname}#${hash}`;
}
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers / insecure origins: a hidden textarea.
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
    ta.remove();
    // Clipboard blocked: show the link to copy by hand.
    if (!ok) window.prompt('Copy this link:', text);
    return ok;
  }
}

/** A public portfolio's profile (no sign-in needed): { portfolio, positions } — positions scaled to a cost of 100. */
export async function fetchPortfolioProfile(id) {
  const res = await fetch(`/api/portfolios/${enc(id)}/profile`, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
