const { ref, reactive, computed } = Vue;
import AlertForm from './AlertForm.js';
import AlertComposer from './AlertComposer.js';
import { alertsStore, loadAlerts, saveAlert, setAlertActive, removeAlert } from '../utils/alertsStore.js';
import { describeAlert, alertStatus, alertSubject } from '../utils/alerts.js';
import { parseOcc } from '../utils/options.js';
import { fetchQuote } from '../services/yahooFinance.js';

// Status filter chips.
const FILTERS = [
  { id: 'all',    label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'off',    label: 'Paused / triggered' },
];

/**
 * Profile → Alerts: every alert you've created, grouped by stock, with
 * Edit (the same form as a stock's 🔔 tab), Pause / Resume / Re-arm and
 * Delete; ＋ New alert opens the multi-stock composer from Inbox → Alerts.
 * Shares utils/alertsStore.js with the stock cards, so all views stay in sync.
 */
export default {
  name: 'AlertsManager',
  components: { AlertForm, AlertComposer },
  props: { config: Object },
  setup(props) {
    const filter = ref('all');
    const search = ref('');
    const composing = ref(false);
    const created = ref(null); // { count, symbols, skipped }
    // The alert being edited: { id, symbol, initial, quote, busy, error }.
    const editing = ref(null);
    const rowErrors = reactive({}); // alert id → message

    const counts = computed(() => {
      const all = alertsStore.alerts.length;
      const active = alertsStore.alerts.filter(a => a.active).length;
      return { all, active, off: all - active };
    });
    const visible = computed(() => {
      const q = search.value.trim().toUpperCase();
      return alertsStore.alerts.filter(a =>
        (filter.value === 'all' || (filter.value === 'active') === !!a.active)
        && (!q || alertSubject(a.symbol).toUpperCase().includes(q) || (a.note ?? '').toUpperCase().includes(q)));
    });
    // Grouped by symbol, A→Z; within a stock, newest first.
    const groups = computed(() => {
      const by = new Map();
      for (const a of visible.value) {
        if (!by.has(a.symbol)) by.set(a.symbol, []);
        by.get(a.symbol).push(a);
      }
      return [...by.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([symbol, alerts]) => ({
          symbol,
          alerts: [...alerts].sort((x, y) => String(y.createdAt ?? '').localeCompare(String(x.createdAt ?? ''))),
        }));
    });

    const avgCostFor = sym => {
      const p = parseOcc(sym) ? props.config?.optionPositions?.[sym] : props.config?.portfolio?.[sym];
      return p?.quantity > 0 ? p.avgCost : null;
    };
    // Option contracts: the form's option mode (short = sold to open).
    const optionFor = sym => {
      const o = parseOcc(sym);
      return o && { ...o, short: props.config?.optionPositions?.[sym]?.side === 'short' };
    };

    async function startEdit(a) {
      composing.value = false;
      delete rowErrors[a.id];
      editing.value = { id: a.id, symbol: a.symbol, initial: a, quote: null, underlyingPrice: null, busy: false, error: null };
      // The form's "= 172.21" helpers and 52-week prefills use the current
      // quote (and an option's, its stock's); it works without, so failures are fine.
      const o = parseOcc(a.symbol);
      await Promise.all([
        fetchQuote(a.symbol).then(q => { if (editing.value?.id === a.id) editing.value.quote = q; }).catch(() => {}),
        o && fetchQuote(o.underlying).then(q => { if (editing.value?.id === a.id) editing.value.underlyingPrice = q.price; }).catch(() => {}),
      ]);
    }
    async function submitEdit(fields) {
      const e = editing.value;
      e.busy = true;
      e.error = null;
      try {
        // Re-saving a one-time alert that already fired re-arms it.
        await saveAlert(e.id, { ...fields, active: true });
        editing.value = null;
      } catch (err) {
        e.error = err.message;
        e.busy = false;
      }
    }

    async function toggle(a) {
      delete rowErrors[a.id];
      try { await setAlertActive(a, !a.active); } catch (e) { rowErrors[a.id] = e.message; }
    }
    async function remove(a) {
      if (!confirm(`Delete this ${a.symbol} alert?\n\n${describeAlert(a)}`)) return;
      delete rowErrors[a.id];
      try { await removeAlert(a.id); } catch (e) { rowErrors[a.id] = e.message; }
    }

    function startNew() {
      editing.value = null;
      created.value = null;
      composing.value = true;
    }
    function onCreated({ alerts, skipped }) {
      composing.value = false;
      created.value = { count: alerts.length, symbols: alerts.map(a => a.symbol), skipped };
    }

    return {
      alertsStore, loadAlerts, FILTERS, filter, search, counts, visible, groups, composing, created, editing, rowErrors,
      avgCostFor, optionFor, alertSubject, startEdit, submitEdit, toggle, remove, startNew, onCreated, describeAlert, alertStatus,
    };
  },
  template: `
    <div class="card account-card alerts-manager">
      <div class="flex-between labels-head">
        <div class="card-title" style="margin-bottom:0">Alerts</div>
        <button type="button" class="primary" v-if="!composing" :disabled="!alertsStore.loaded" @click="startNew">＋ New alert</button>
      </div>
      <p class="text-muted text-sm" style="margin:8px 0 4px">
        Every alert you've set, on any stock. Triggered alerts arrive in <strong>Inbox → Alerts</strong>;
        each stock's <strong>🔔</strong> tab shows its own alerts too.
      </p>

      <AlertComposer v-if="composing" :config="config" @done="onCreated" @cancel="composing = false" />
      <div class="notice inbox-created" v-if="created && !composing" style="margin-top:12px">
        <template v-if="created.count">✓ Created {{ created.count }} alert{{ created.count === 1 ? '' : 's' }} ({{ created.symbols.join(', ') }}).</template>
        <template v-else>No alerts were created.</template>
        <template v-if="created.skipped.length"> Skipped {{ created.skipped.map(s => s.symbol + ' (' + s.reason + ')').join(', ') }}.</template>
        <button type="button" class="link-button" aria-label="Dismiss" @click="created = null">✕</button>
      </div>

      <div class="notice error" v-if="alertsStore.error" style="margin-top:12px">
        Couldn't load your alerts: {{ alertsStore.error }}
        <button type="button" class="link-button" @click="loadAlerts">Retry</button>
      </div>
      <div class="skeleton" style="height:120px;margin-top:12px" v-else-if="!alertsStore.loaded"></div>
      <p class="text-muted text-sm" style="margin:14px 0 0" v-else-if="!alertsStore.alerts.length && !composing">
        No alerts yet — create one with <strong>＋ New alert</strong>, or from a stock's 🔔 tab.
      </p>

      <template v-else-if="alertsStore.alerts.length">
        <div class="alerts-filters">
          <div class="note-chips" role="group" aria-label="Show">
            <button v-for="f in FILTERS" :key="f.id" type="button" class="note-chip" :class="{ selected: filter === f.id }"
                    :aria-pressed="filter === f.id" @click="filter = f.id">
              {{ f.label }} <span class="note-chip-count">{{ counts[f.id] }}</span>
            </button>
          </div>
          <input class="alerts-search" type="search" v-model="search" placeholder="Filter by ticker or note"
                 aria-label="Filter alerts by ticker or note" autocomplete="off" />
        </div>

        <p class="text-muted text-sm" style="margin:12px 0 0" v-if="!groups.length">No alerts match.</p>

        <section class="alerts-group" v-for="g in groups" :key="g.symbol" :aria-label="g.symbol + ' alerts'">
          <h4 class="alerts-group-title">{{ alertSubject(g.symbol) }} <span class="holdings-count">{{ g.alerts.length }}</span></h4>
          <ul class="alert-list">
            <li v-for="a in g.alerts" :key="a.id" class="alert-item" :class="{ inactive: !a.active, editing: editing?.id === a.id }">
              <AlertForm v-if="editing?.id === a.id" :symbol="a.symbol" :quote="editing.quote" :avg-cost="avgCostFor(a.symbol)"
                         :option="optionFor(a.symbol)" :underlying-price="editing.underlyingPrice"
                         :initial="editing.initial" submit-label="Save changes"
                         :busy="editing.busy" :error="editing.error"
                         @save="submitEdit" @cancel="editing = null" />
              <template v-else>
                <span class="alert-dot" :class="a.active ? 'on' : 'off'" aria-hidden="true"></span>
                <div class="alert-item-body">
                  <div class="alert-item-title">{{ describeAlert(a) }}</div>
                  <div class="text-muted text-sm">{{ alertStatus(a) }} · {{ a.repeat === 'daily' ? 'every day' : 'once' }}</div>
                  <div class="alert-item-note" v-if="a.note">{{ a.note }}</div>
                  <div class="notice error" v-if="rowErrors[a.id]" style="margin:4px 0 0">{{ rowErrors[a.id] }}</div>
                </div>
                <div class="alert-item-actions">
                  <button type="button" class="link-button" @click="startEdit(a)">Edit</button>
                  <button type="button" class="link-button" @click="toggle(a)">
                    {{ a.active ? 'Pause' : (a.repeat === 'once' && a.lastTriggeredAt ? 'Re-arm' : 'Resume') }}
                  </button>
                  <button type="button" class="link-button danger-link" @click="remove(a)">Delete</button>
                </div>
              </template>
            </li>
          </ul>
        </section>
      </template>
    </div>
  `,
};
