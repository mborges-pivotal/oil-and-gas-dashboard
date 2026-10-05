/**
 * Inbox state shared by the header (unread badge) and the Inbox page.
 *
 * Items are shaped { id, title, body?, createdAt, read }. Alerts are filled
 * by utils/alertsStore.js (triggered stock alerts); messages arrive with the
 * group feature. Notes are the user's own writing and never count as unread.
 * A section can register a persister so read state is saved server-side.
 */
const { reactive } = Vue;

export const inboxStore = reactive({
  alerts: [],
  messages: [],
});

export function unreadAlerts() {
  return inboxStore.alerts.filter(a => !a.read).length;
}

export function unreadMessages() {
  return inboxStore.messages.filter(m => !m.read).length;
}

/** Unread alerts + messages — the number on the Inbox tab. */
export function unreadTotal() {
  return unreadAlerts() + unreadMessages();
}

/** Where opening Inbox should land: unread alerts first, then messages, else Notes. */
export function defaultInboxSection() {
  if (unreadAlerts()) return 'alerts';
  if (unreadMessages()) return 'messages';
  return 'notes';
}

const persisters = {}; // section → (ids | undefined) => Promise

export function onMarkRead(section, fn) {
  persisters[section] = fn;
}

/** Mark one item read (and save it, if the section has a persister). */
export function markRead(section, item) {
  if (item.read) return;
  item.read = true;
  persisters[section]?.([item.id]);
}

export function markAllRead(section) {
  const unread = (inboxStore[section] ?? []).filter(i => !i.read);
  if (!unread.length) return;
  for (const item of unread) item.read = true;
  persisters[section]?.();
}

export function clearInbox() {
  inboxStore.alerts = [];
  inboxStore.messages = [];
}
