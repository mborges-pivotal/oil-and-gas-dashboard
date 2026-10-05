/**
 * Client for /api/notes (server/notes.js) — a signed-in user's notes (news
 * articles saved from a stock's News tab, or manual notes) and their labels. Mutations return { note, labels } where labels is
 * the user's full, refreshed label list.
 */
import { request } from './auth.js';

export async function fetchNotes() {
  return request('GET', '/api/notes'); // { notes, labels }
}

/** article: { symbol, title, link, source, pubDate, image }; labels: names. */
export async function createNote(article, note, labels) {
  return request('POST', '/api/notes', { ...article, note, labels });
}

/** A note written on the Notes tab: { symbols, link, note, labels }. */
export async function createManualNote({ symbols, link, note, labels }) {
  return request('POST', '/api/notes', { kind: 'manual', symbols, link, note, labels });
}

/** Partial update — any of { note, labels }, plus { symbols, link } for manual notes. */
export async function updateNote(id, fields) {
  return request('PUT', `/api/notes/${encodeURIComponent(id)}`, fields);
}

export async function deleteNote(id) {
  await request('DELETE', `/api/notes/${encodeURIComponent(id)}`);
}

/** fields: { name, description?, color? } → { label, labels } */
export async function createLabel(fields) {
  return request('POST', '/api/notes/labels', fields);
}

/** Partial update — any of { name, description, color } → { labels } */
export async function updateLabel(id, fields) {
  return request('PUT', `/api/notes/labels/${encodeURIComponent(id)}`, fields);
}

export async function deleteLabel(id) {
  await request('DELETE', `/api/notes/labels/${encodeURIComponent(id)}`);
}
