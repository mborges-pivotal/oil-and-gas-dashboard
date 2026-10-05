const { ref, computed, onMounted } = Vue;
import AlertForm from './AlertForm.js';
import { fetchWatchlists } from '../services/watchlists.js';
import { saveAlertsBulk } from '../utils/alertsStore.js';

/**
 * New alert from Inbox → Alerts: pick stocks — one-tap groups (Default,
 * each of your watchlists, Portfolio holdings), typed tickers, ✕ to filter
 * any out — then one alert condition, created once per stock.
 * Emits done({ alerts, skipped }) and cancel.
 */
const TICKER_RE = /^\^?[A-Z0-9][A-Z0-9.\-=]{0,19}$/;
const MAX_STOCKS = 50; // matches server/alerts.js MAX_BULK

export default {
  name: 'AlertComposer',
  components: { AlertForm },
  props: { config: Object },
  emits: ['done', 'cancel'],
  setup(props, { emit }) {
    const selected = ref([]);
    const newTicker = ref('');
    const watchlists = ref([]);
    const pickError = ref(null);
    const busy = ref(false);
    const saveError = ref(null);
    const kind = ref('price'); // tracked from the form, for the position note

    onMounted(async () => {
      try { watchlists.value = await fetchWatchlists(); } catch { /* groups from settings still work */ }
    });

    const held = computed(() =>
      Object.entries(props.config?.portfolio ?? {}).filter(([, p]) => p?.quantity > 0).map(([s]) => s)
    );
    const groups = computed(() => [
      { id: 'default', label: 'Default', symbols: props.config?.stocks?.tickers ?? [] },
      ...watchlists.value.map(l => ({ id: 'wl-' + l.id, label: l.name, symbols: l.tickers })),
      { id: 'portfolio', label: 'Portfolio', symbols: held.value },
    ].filter(g => g.symbols.length));
    const suggestions = computed(() =>
      [...new Set(groups.value.flatMap(g => g.symbols))].filter(s => !selected.value.includes(s)).sort()
    );

    const isWholeGroup = g => g.symbols.every(s => selected.value.includes(s));
    function toggleGroup(g) {
      pickError.value = null;
      if (isWholeGroup(g)) {
        selected.value = selected.value.filter(s => !g.symbols.includes(s));
        return;
      }
      const next = [...selected.value];
      for (const s of g.symbols) if (!next.includes(s)) next.push(s);
      if (next.length > MAX_STOCKS) {
        pickError.value = `Pick at most ${MAX_STOCKS} stocks at a time.`;
        return;
      }
      selected.value = next;
    }
    function removeStock(sym) {
      selected.value = selected.value.filter(s => s !== sym);
    }
    function addTicker() {
      const sym = newTicker.value.trim().toUpperCase();
      if (!sym) return;
      if (!TICKER_RE.test(sym)) {
        pickError.value = `"${newTicker.value.trim()}" isn't a ticker symbol.`;
        return;
      }
      if (!selected.value.includes(sym)) {
        if (selected.value.length >= MAX_STOCKS) {
          pickError.value = `Pick at most ${MAX_STOCKS} stocks at a time.`;
          return;
        }
        selected.value = [...selected.value, sym];
      }
      pickError.value = null;
      newTicker.value = '';
    }
    function onTickerKeydown(e) {
      if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
        e.preventDefault();
        addTicker();
      } else if (e.key === 'Backspace' && !newTicker.value && selected.value.length) {
        selected.value = selected.value.slice(0, -1);
      }
    }

    const heldSelected = computed(() => selected.value.filter(s => held.value.includes(s)).length);
    const summary = computed(() => {
      const n = selected.value.length;
      if (!n) return 'No stocks selected yet.';
      if (kind.value === 'position') {
        const k = heldSelected.value;
        return `${k} of ${n} selected stock${n === 1 ? '' : 's'} ${k === 1 ? 'is' : 'are'} in your Portfolio — creates ${k} alert${k === 1 ? '' : 's'}; the rest are skipped.`;
      }
      return `Creates ${n} alert${n === 1 ? '' : 's'} — one per stock.`;
    });

    async function save(fields) {
      saveError.value = null;
      if (newTicker.value.trim()) addTicker(); // a typed-but-not-added ticker counts
      if (!selected.value.length) {
        saveError.value = 'Pick at least one stock.';
        return;
      }
      busy.value = true;
      try {
        emit('done', await saveAlertsBulk({ symbols: selected.value, ...fields }));
      } catch (e) {
        saveError.value = e.message;
      } finally {
        busy.value = false;
      }
    }

    return {
      selected, newTicker, groups, suggestions, pickError, busy, saveError, kind, summary,
      isWholeGroup, toggleGroup, removeStock, addTicker, onTickerKeydown, save,
    };
  },
  template: `
    <div class="card alert-composer">
      <div class="card-title" style="margin-bottom:8px">New alert</div>

      <div class="alert-composer-section">
        <span class="alert-field-label">Stocks</span>
        <div class="note-chips alert-groups" v-if="groups.length" role="group" aria-label="Add a group of stocks">
          <span class="alert-presets-label">Add group</span>
          <button v-for="g in groups" :key="g.id" type="button" class="note-chip" :class="{ selected: isWholeGroup(g) }"
                  :aria-pressed="isWholeGroup(g)" :title="g.symbols.join(', ')" @click="toggleGroup(g)">
            <span aria-hidden="true">{{ isWholeGroup(g) ? '✓ ' : '+ ' }}</span>{{ g.label }} <span class="note-chip-count">{{ g.symbols.length }}</span>
          </button>
        </div>
        <div class="note-chips" role="group" aria-label="Selected stocks">
          <span class="note-chip selected note-symbol-chip" v-for="s in selected" :key="s">
            {{ s }}
            <button type="button" class="note-symbol-remove" :aria-label="'Remove ' + s" @click="removeStock(s)">✕</button>
          </span>
          <input class="note-new-label note-new-symbol" v-model="newTicker" maxlength="20" autocomplete="off"
                 list="alert-composer-symbols" :placeholder="selected.length ? '+ Ticker' : 'Type a ticker, press Enter — or add a group above'"
                 aria-label="Add a stock ticker" @keydown="onTickerKeydown" @change="addTicker" />
          <datalist id="alert-composer-symbols">
            <option v-for="s in suggestions" :key="s" :value="s"></option>
          </datalist>
          <button type="button" class="link-button" v-if="selected.length > 1" @click="selected = []">Clear all</button>
        </div>
        <div class="alert-helper">{{ summary }}</div>
        <div class="notice error alert-error" v-if="pickError">{{ pickError }}</div>
      </div>

      <AlertForm multi :submit-label="selected.length > 1 ? 'Create ' + selected.length + ' alerts' : 'Create alert'"
                 :busy="busy" :error="saveError"
                 @kind-change="kind = $event" @save="save" @cancel="$emit('cancel')" />
    </div>
  `,
};
