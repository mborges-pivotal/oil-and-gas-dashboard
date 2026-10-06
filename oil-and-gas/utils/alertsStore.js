/**
 * The signed-in user's alerts, shared by every stock card's Alerts tab, and
 * the check loop's hand-off of triggered events to Inbox → Alerts.
 * app.js loads this on sign-in, runs checkNow() on each quote refresh, and
 * clears it on sign-out.
 */
import * as api from '../services/alerts.js';
import { inboxStore } from './inboxStore.js';

const { reactive } = Vue;

export const alertsStore = reactive({ alerts: [], loaded: false, error: null });

const toInboxItem = e => ({ id: e.id, title: e.title, body: e.body, createdAt: e.createdAt, read: e.read, symbol: e.symbol, ackedAt: e.ackedAt ?? null });

export async function loadAlerts() {
  alertsStore.error = null;
  try {
    const [alerts, events] = await Promise.all([api.fetchAlerts(), api.fetchAlertEvents()]);
    alertsStore.alerts = alerts;
    alertsStore.loaded = true;
    inboxStore.alerts = events.map(toInboxItem);
  } catch (e) {
    alertsStore.error = e.message;
  }
}

export function clearAlerts() {
  Object.assign(alertsStore, { alerts: [], loaded: false, error: null });
}

export function alertsFor(symbol) {
  return alertsStore.alerts.filter(a => a.symbol === symbol);
}

// Newly fired alerts go to the top of Inbox → Alerts.
function addEvents(events) {
  for (const e of [...events].reverse()) {
    if (!inboxStore.alerts.some(x => x.id === e.id)) inboxStore.alerts.unshift(toInboxItem(e));
  }
}

/** Evaluate all active alerts now (called on each quote refresh). */
export async function checkNow() {
  try {
    const { events, alerts } = await api.checkAlerts();
    alertsStore.alerts = alerts;
    addEvents(events);
  } catch {
    // best-effort: the next quote refresh tries again
  }
}

function replace(alert) {
  const i = alertsStore.alerts.findIndex(a => a.id === alert.id);
  if (i === -1) alertsStore.alerts.push(alert);
  else alertsStore.alerts[i] = alert;
}

// The server evaluates a new / edited / re-armed alert immediately, so one
// that's already met fires now and comes back in `events`.
export async function saveAlert(id, fields) {
  const { alert, events } = id ? await api.updateAlert(id, fields) : await api.createAlert(fields);
  replace(alert);
  addEvents(events);
  return alert;
}

/** Create one alert per symbol (Inbox → Alerts → New alert) → { alerts, skipped }. */
export async function saveAlertsBulk(fields) {
  const { alerts, skipped, events } = await api.createAlertsBulk(fields);
  for (const a of alerts) replace(a);
  addEvents(events);
  return { alerts, skipped };
}

export async function setAlertActive(alert, active) {
  const res = await api.updateAlert(alert.id, { active });
  replace(res.alert);
  addEvents(res.events);
}

export async function removeAlert(id) {
  await api.deleteAlert(id);
  alertsStore.alerts = alertsStore.alerts.filter(a => a.id !== id);
}

/**
 * Acknowledge triggered alerts (Inbox → Alerts) — they move to the
 * Acknowledged group and count as read — or un-acknowledge them (back to the
 * list, still read). `items` omitted with acked = every unacknowledged one.
 * Updates the list right away; puts it back if the save fails.
 */
export async function ackAlertItems(items, acked) {
  const targets = items ?? inboxStore.alerts.filter(a => !a.ackedAt);
  if (!targets.length) return;
  const before = targets.map(a => ({ a, ackedAt: a.ackedAt, read: a.read }));
  const now = new Date().toISOString();
  for (const a of targets) {
    a.ackedAt = acked ? (a.ackedAt ?? now) : null;
    if (acked) a.read = true;
  }
  try {
    await api.ackAlertEvents(items ? targets.map(a => a.id) : undefined, acked);
  } catch (e) {
    for (const b of before) Object.assign(b.a, { ackedAt: b.ackedAt, read: b.read });
    throw e;
  }
}

/** Persist read state for Inbox → Alerts items (ids, or all when omitted). */
export function persistAlertsRead(ids) {
  return api.markAlertEventsRead(ids).catch(() => {});
}
