const { ref, computed, watch } = Vue;
import Notes from './Notes.js';
import AlertComposer from './AlertComposer.js';
import ActivityFeed from './ActivityFeed.js';
import { inboxStore, unreadAlerts, unreadMessages, markRead, markAllRead } from '../utils/inboxStore.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { ackAlertItems } from '../utils/alertsStore.js';

const SECTIONS = [
  { id: 'notes',    label: 'Notes' },
  { id: 'alerts',   label: 'Alerts' },
  { id: 'messages', label: 'Activity' }, // portfolio updates (ActivityFeed) — id kept
];

/**
 * Inbox tab (signed in): Notes · Alerts · Activity (portfolio updates: You / Following). The open sub-tab is
 * owned by app.js (`section` / update:section) so it can pick the default
 * — unread alerts, then messages, else Notes — each time Inbox opens.
 */
export default {
  name: 'Inbox',
  components: { Notes, AlertComposer, ActivityFeed },
  props: { config: Object, section: { type: String, default: 'notes' }, focusPost: { type: [Number, String], default: null } },
  emits: ['update:section', 'manage-labels', 'manage-alerts', 'discover', 'share', 'clear-focus'],
  setup() {
    const counts = computed(() => ({ notes: 0, alerts: unreadAlerts(), messages: unreadMessages() }));
    // Alerts: those still to deal with; acknowledged ones sit in a collapsible group below.
    const items = computed(() => ({ alerts: inboxStore.alerts.filter(a => !a.ackedAt), messages: inboxStore.messages }));
    const acked = computed(() => inboxStore.alerts.filter(a => a.ackedAt)
      .sort((a, b) => b.ackedAt.localeCompare(a.ackedAt)));
    const ACKED_KEY = 'oilgas_acked_open';
    const ackedOpen = ref((() => {
      try { return localStorage.getItem(ACKED_KEY) === '1'; } catch { return false; }
    })());
    watch(ackedOpen, open => { try { localStorage.setItem(ACKED_KEY, open ? '1' : '0'); } catch { /* per-browser only */ } });
    const ackError = ref(null);
    async function ack(list, value) {
      ackError.value = null;
      try {
        await ackAlertItems(list, value);
      } catch (e) {
        ackError.value = `Couldn't ${value ? 'acknowledge' : 'un-acknowledge'}: ${e.message}`;
      }
    }
    // ＋ New alert (Alerts sub-tab): the composer, then a short result line.
    const composing = ref(false);
    const created = ref(null); // { count, symbols, skipped }
    function onCreated({ alerts, skipped }) {
      composing.value = false;
      created.value = { count: alerts.length, symbols: alerts.map(a => a.symbol), skipped };
    }
    return { SECTIONS, counts, items, acked, ackedOpen, ack, ackError, markRead, markAllRead, formatRelativeTime, composing, created, onCreated };
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

      <Notes v-if="section === 'notes'" :config="config" embedded @manage-labels="$emit('manage-labels')" />
      <ActivityFeed v-else-if="section === 'messages'" :focus-post="focusPost"
                    @discover="$emit('discover')" @share="$emit('share')" @clear-focus="$emit('clear-focus')" />

      <template v-else>
        <div class="inbox-list-head" v-if="counts[section] || section === 'alerts'">
          <button type="button" class="link-button" v-if="counts[section]" @click="markAllRead(section)">Mark all as read</button>
          <button type="button" class="link-button" v-if="section === 'alerts' && items.alerts.length" @click="ack(null, true)">Acknowledge all</button>
          <button type="button" class="link-button" v-if="section === 'alerts'" @click="$emit('manage-alerts')">Manage alerts</button>
          <button type="button" class="primary inbox-new-alert" v-if="section === 'alerts' && !composing"
                  @click="composing = true; created = null">＋ New alert</button>
        </div>
        <AlertComposer v-if="section === 'alerts' && composing" :config="config"
                       @done="onCreated" @cancel="composing = false" />
        <div class="notice inbox-created" v-if="section === 'alerts' && created && !composing">
          <template v-if="created.count">
            ✓ Created {{ created.count }} alert{{ created.count === 1 ? '' : 's' }} ({{ created.symbols.join(', ') }}).
          </template>
          <template v-else>No alerts were created.</template>
          <template v-if="created.skipped.length">
            Skipped {{ created.skipped.map(s => s.symbol + ' (' + s.reason + ')').join(', ') }}.
          </template>
          Edit, pause or delete them in <a href="#" @click.prevent="$emit('manage-alerts')">Profile → Alerts</a> or each stock's 🔔 tab.
          <button type="button" class="link-button" aria-label="Dismiss" @click="created = null">✕</button>
        </div>
        <div class="notice error" v-if="section === 'alerts' && ackError">{{ ackError }}</div>
        <div class="notice" v-if="section === 'alerts' && !items.alerts.length && acked.length">
          All caught up — every triggered alert has been acknowledged.
        </div>
        <div class="notice" v-else-if="!items[section].length">
          <template v-if="section === 'alerts'">
            Nothing has triggered yet. Use <strong>＋ New alert</strong> to set one up for any group of stocks
            (or from a stock's <strong>🔔</strong> tab) — when it triggers, it shows up here and the Inbox tab shows
            how many are unread.
          </template>
        </div>
        <ul class="inbox-list" v-if="items[section].length">
          <li v-for="item in items[section]" :key="item.id" class="card inbox-item" :class="{ unread: !item.read }"
              @click="markRead(section, item)">
            <span class="inbox-dot" v-if="!item.read" aria-label="Unread"></span>
            <div class="inbox-item-body">
              <div class="inbox-item-title">{{ item.title }}</div>
              <div class="inbox-item-text" v-if="item.body">{{ item.body }}</div>
            </div>
            <div class="inbox-item-side">
              <span class="text-muted text-sm inbox-item-time">{{ formatRelativeTime(item.createdAt) }}</span>
              <button type="button" class="link-button inbox-ack" v-if="section === 'alerts'" @click.stop="ack([item], true)"
                      title="Acknowledge — moves it to Acknowledged">✓ Acknowledge</button>
            </div>
          </li>
        </ul>

        <!-- Alerts: acknowledged ones, collapsible; un-acknowledge to move one back -->
        <section class="inbox-acked" v-if="section === 'alerts' && acked.length">
          <button type="button" class="notes-archived-toggle" :aria-expanded="ackedOpen" aria-controls="inbox-acked-list"
                  @click="ackedOpen = !ackedOpen">
            <span class="holdings-chevron" aria-hidden="true">▶</span>
            Acknowledged <span class="holdings-count">{{ acked.length }}</span>
          </button>
          <ul class="inbox-list" id="inbox-acked-list" v-show="ackedOpen">
            <li v-for="item in acked" :key="item.id" class="card inbox-item acked">
              <span class="inbox-ack-mark" aria-hidden="true">✓</span>
              <div class="inbox-item-body">
                <div class="inbox-item-title">{{ item.title }}</div>
                <div class="inbox-item-text" v-if="item.body">{{ item.body }}</div>
              </div>
              <div class="inbox-item-side">
                <span class="text-muted text-sm inbox-item-time" :title="'Triggered ' + formatRelativeTime(item.createdAt)">acked {{ formatRelativeTime(item.ackedAt) }}</span>
                <button type="button" class="link-button inbox-ack" @click.stop="ack([item], false)"
                        title="Move it back to the alerts list">Un-acknowledge</button>
              </div>
            </li>
          </ul>
        </section>
      </template>
    </div>
  `,
};
