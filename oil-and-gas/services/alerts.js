/**
 * Client for /api/alerts (server/alerts.js) — a signed-in user's stock
 * alerts, the check that evaluates them, and the triggered events that
 * Inbox → Alerts lists.
 */
import { request } from './auth.js';

export async function fetchAlerts() {
  return (await request('GET', '/api/alerts')).alerts;
}

/** alert: { symbol, kind, params, repeat, note } → { alert, events } (events: fired right away) */
export async function createAlert(alert) {
  return request('POST', '/api/alerts', alert);
}

/** Partial update — any of { kind + params, repeat, note, active } → { alert, events }. */
export async function updateAlert(id, fields) {
  return request('PUT', `/api/alerts/${encodeURIComponent(id)}`, fields);
}

export async function deleteAlert(id) {
  await request('DELETE', `/api/alerts/${encodeURIComponent(id)}`);
}

/** Evaluate all active alerts now → { events (newly fired), alerts }. */
export async function checkAlerts() {
  return request('POST', '/api/alerts/check');
}

export async function fetchAlertEvents() {
  return (await request('GET', '/api/alerts/events')).events;
}

/** Mark events read — pass ids, or nothing for all. */
export async function markAlertEventsRead(ids) {
  await request('POST', '/api/alerts/events/read', ids ? { ids } : {});
}
