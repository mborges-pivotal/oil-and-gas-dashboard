const { computed } = Vue;
import { formatPrice, formatPct } from '../utils/formatters.js';

/**
 * Top movers card: the biggest gainers and losers by today's % change
 * across the selected lists. On My Account → Watchlist the lists are your
 * watchlists, toggled as chips in the card (any combination, at least one;
 * v-model:selected-ids); on the Portfolio page there's a single source,
 * your holdings, and no selector. Quotes come from the parent, which keeps
 * them fetched and refreshed. Clicking a mover emits select(symbol).
 */
const PER_SIDE = 3;

export default {
  name: 'TopMovers',
  props: {
    sources: { type: Array, default: () => [] },  // [{ id, label, symbols }]
    selectedIds: { type: Array, default: () => [] },
    quotes: { type: Object, default: () => ({}) }, // symbol → quote
  },
  emits: ['update:selectedIds', 'select'],
  setup(props, { emit }) {
    // Selected sources that still exist; falls back to the first one.
    const active = computed(() => {
      const picked = props.sources.filter(s => props.selectedIds.includes(s.id));
      return picked.length ? picked : props.sources.slice(0, 1);
    });
    const isOn = s => active.value.includes(s);
    function toggle(s) {
      const ids = active.value.map(a => a.id);
      if (isOn(s)) {
        if (ids.length === 1) return; // keep at least one list
        emit('update:selectedIds', ids.filter(id => id !== s.id));
      } else {
        emit('update:selectedIds', [...ids, s.id]);
      }
    }
    // Every selected list's stocks, each once.
    const symbols = computed(() => [...new Set(active.value.flatMap(s => s.symbols))]);

    const rows = computed(() => symbols.value
      .map(sym => {
        const q = props.quotes[sym];
        return { sym, name: q?.shortName ?? '', price: q?.price ?? null, pct: q?.pctChange ?? null };
      }));
    const priced = computed(() => rows.value.filter(r => r.price != null && r.pct != null && Number.isFinite(r.pct)));
    const gainers = computed(() => priced.value.filter(r => r.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, PER_SIDE));
    const losers = computed(() => priced.value.filter(r => r.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, PER_SIDE));
    const loading = computed(() => rows.value.length > 0 && priced.value.length === 0
      && rows.value.some(r => props.quotes[r.sym]?.loading !== false));
    // Bars share one scale across both columns, so sizes compare.
    const maxAbs = computed(() => Math.max(0.0001, ...[...gainers.value, ...losers.value].map(r => Math.abs(r.pct))));
    const barWidth = r => `${Math.max(4, (Math.abs(r.pct) / maxAbs.value) * 100)}%`;

    return { active, isOn, toggle, rows, priced, gainers, losers, loading, barWidth, formatPrice, formatPct, PER_SIDE };
  },
  template: `
    <div class="card movers-card" v-if="sources.length">
      <div class="movers-head">
        <div class="card-title" style="margin-bottom:0">Top movers</div>
        <span v-if="sources.length === 1" class="text-muted text-sm">{{ sources[0].label }}</span>
      </div>
      <div class="note-chips movers-lists" v-if="sources.length > 1" role="group" aria-label="Watchlists to include">
        <button v-for="s in sources" :key="s.id" type="button" class="note-chip" :class="{ selected: isOn(s) }"
                :aria-pressed="isOn(s)" :disabled="isOn(s) && active.length === 1"
                :title="isOn(s) && active.length === 1 ? 'At least one list stays selected' : s.symbols.join(', ')"
                @click="toggle(s)">
          <span aria-hidden="true">{{ isOn(s) ? '✓ ' : '+ ' }}</span>{{ s.label }} <span class="note-chip-count">{{ s.symbols.length }}</span>
        </button>
      </div>

      <div class="skeleton" style="height:96px" v-if="loading"></div>
      <div class="movers-cols" v-else>
        <section v-for="side in [{ key: 'up', title: 'Gainers', items: gainers }, { key: 'down', title: 'Losers', items: losers }]"
                 :key="side.key" class="movers-side" :aria-label="side.title">
          <h4 class="movers-side-title">{{ side.title }}</h4>
          <ol class="movers-list" v-if="side.items.length">
            <li v-for="r in side.items" :key="r.sym">
              <button type="button" class="movers-row" :title="r.name ? r.sym + ' — ' + r.name : r.sym" @click="$emit('select', r.sym)">
                <span class="movers-sym">{{ r.sym }}</span>
                <span class="movers-name">{{ r.name }}</span>
                <span class="movers-price">{{ formatPrice(r.price) }}</span>
                <span class="movers-pct" :class="side.key === 'up' ? 'positive' : 'negative'">{{ formatPct(r.pct) }}</span>
                <span class="movers-bar" aria-hidden="true"><span :class="side.key" :style="{ width: barWidth(r) }"></span></span>
              </button>
            </li>
          </ol>
          <p class="text-muted text-sm movers-empty" v-else>
            {{ side.key === 'up' ? 'Nothing up today.' : 'Nothing down today.' }}
          </p>
        </section>
      </div>

      <p class="text-muted text-sm movers-note" v-if="!loading">
        Today's % change vs. the previous close · top {{ PER_SIDE }} each way of {{ priced.length }}
        stock{{ priced.length === 1 ? '' : 's' }}{{ active.length > 1 ? ' across ' + active.length + ' lists' : '' }}{{ priced.length < rows.length ? ' (' + (rows.length - priced.length) + ' without a quote)' : '' }}.
      </p>
    </div>
  `,
};
