const { computed } = Vue;
import Notes from './Notes.js';
import { inboxStore, unreadAlerts, unreadMessages, markRead, markAllRead } from '../utils/inboxStore.js';
import { formatRelativeTime } from '../utils/formatters.js';

const SECTIONS = [
  { id: 'notes',    label: 'Notes' },
  { id: 'alerts',   label: 'Alerts' },
  { id: 'messages', label: 'Messages' },
];

/**
 * Inbox tab (signed in): Notes · Alerts · Messages. The open sub-tab is
 * owned by app.js (`section` / update:section) so it can pick the default
 * — unread alerts, then messages, else Notes — each time Inbox opens.
 */
export default {
  name: 'Inbox',
  components: { Notes },
  props: { config: Object, section: { type: String, default: 'notes' } },
  emits: ['update:section'],
  setup() {
    const counts = computed(() => ({ notes: 0, alerts: unreadAlerts(), messages: unreadMessages() }));
    const items = computed(() => ({ alerts: inboxStore.alerts, messages: inboxStore.messages }));
    return { SECTIONS, counts, items, markRead, markAllRead, formatRelativeTime };
  },
  template: `
    <div>
      <div class="section-header mb-16">Inbox</div>

      <div class="subtab-bar" role="tablist" aria-label="Inbox sections">
        <button v-for="s in SECTIONS" :key="s.id" type="button" role="tab" class="subtab-btn"
                :class="{ active: section === s.id }" :aria-selected="section === s.id"
                @click="$emit('update:section', s.id)">
          {{ s.label }}<span class="count-badge" v-if="counts[s.id]" :aria-label="counts[s.id] + ' unread'">{{ counts[s.id] }}</span>
        </button>
      </div>

      <Notes v-if="section === 'notes'" :config="config" embedded />

      <template v-else>
        <div class="inbox-list-head" v-if="counts[section]">
          <button type="button" class="link-button" @click="markAllRead(section)">Mark all as read</button>
        </div>
        <div class="notice" v-if="!items[section].length">
          <template v-if="section === 'alerts'">
            No alerts yet. Create one from a stock's <strong>🔔</strong> tab (Markets → Stocks → open a stock) —
            when it triggers, it shows up here and the Inbox tab shows how many are unread.
          </template>
          <template v-else>
            No messages yet. Once groups are available, messages from your groups will show up here,
            and the Inbox tab will show how many are unread.
          </template>
        </div>
        <ul class="inbox-list" v-else>
          <li v-for="item in items[section]" :key="item.id" class="card inbox-item" :class="{ unread: !item.read }"
              @click="markRead(section, item)">
            <span class="inbox-dot" v-if="!item.read" aria-label="Unread"></span>
            <div class="inbox-item-body">
              <div class="inbox-item-title">{{ item.title }}</div>
              <div class="inbox-item-text" v-if="item.body">{{ item.body }}</div>
            </div>
            <span class="text-muted text-sm inbox-item-time">{{ formatRelativeTime(item.createdAt) }}</span>
          </li>
        </ul>
      </template>
    </div>
  `,
};
