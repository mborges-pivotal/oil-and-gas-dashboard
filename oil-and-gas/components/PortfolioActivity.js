const { ref, computed, watch } = Vue;
import { formatUSD, formatPrice, formatDate, changeClass } from '../utils/formatters.js';
import { MULTIPLIER, optionLabel } from '../utils/options.js';

/**
 * Portfolio → Activity: every recorded trade, newest first, grouped by
 * month — stock purchases and sales, and option opens, closes and
 * expirations — from open positions and Closed positions alike. Built from
 * the transactions saved on each position (config.portfolio,
 * config.optionPositions, config.closedPositions), so it's read-only:
 * trades are added, closed or deleted on the position itself. Positions
 * entered as a total (quantity × average cost) have no trades to list.
 */
const KINDS = [
  { id: 'all',     label: 'All' },
  { id: 'stock',   label: 'Stocks' },
  { id: 'option',  label: 'Options' },
];

const sharesFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const signedUSD = v => (v > 0 ? '+' : v < 0 ? '−' : '') + formatUSD(Math.abs(v));

export default {
  name: 'PortfolioActivity',
  props: { config: Object },
  setup(props) {
    const kind = ref('all');
    const query = ref('');

    // One row per trade: { id, date, kind, action, symbol, title, quantity, unit, price,
    //   cash (signed flow: − paid, + received), realized, via, closed }
    const rows = computed(() => {
      const out = [];
      const stockRows = (symbol, txs, closed) => {
        for (const t of txs ?? []) {
          const sell = t.type === 'sell';
          out.push({
            id: `s-${symbol}-${t.id}`, date: t.date, kind: 'stock', action: sell ? 'Sell' : 'Buy',
            symbol, title: symbol, quantity: t.quantity, unit: 'shares', price: t.price,
            cash: (sell ? 1 : -1) * t.quantity * t.price, realized: sell ? t.realized : null,
            via: t.paidFrom ? `from ${t.paidFrom}` : t.depositTo ? `to ${t.depositTo}` : '', closed,
          });
        }
      };
      const optionRows = (occ, o, txs, closed) => {
        const m = o.multiplier ?? MULTIPLIER;
        const short = o.side === 'short';
        for (const t of txs ?? []) {
          const open = t.type === 'open';
          const action = open ? (short ? 'Sell to open' : 'Buy to open')
            : t.expired ? 'Expired' : (short ? 'Buy to close' : 'Sell to close');
          // Money in: selling to open a short, or closing a long; out otherwise.
          const inflow = open ? short : !short;
          out.push({
            id: `o-${occ}-${t.id}`, date: t.date, kind: 'option', action, symbol: o.underlying,
            title: optionLabel(occ), quantity: t.quantity, unit: t.quantity === 1 ? 'contract' : 'contracts', price: t.price,
            cash: (inflow ? 1 : -1) * t.quantity * m * t.price, realized: open ? null : t.realized,
            via: t.cash ? `${t.cashDir === 'out' ? 'from' : 'to'} ${t.cash}` : '', closed,
          });
        }
      };
      for (const [sym, p] of Object.entries(props.config?.portfolio ?? {})) stockRows(sym, p?.transactions, false);
      for (const [occ, p] of Object.entries(props.config?.optionPositions ?? {})) if (p) optionRows(occ, p, p.transactions, false);
      for (const c of props.config?.closedPositions ?? []) {
        if (c.kind === 'option') optionRows(c.symbol, c.option, c.transactions, true);
        else stockRows(c.symbol, c.transactions, true);
      }
      return out.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    });

    const counts = computed(() => ({
      all: rows.value.length,
      stock: rows.value.filter(r => r.kind === 'stock').length,
      option: rows.value.filter(r => r.kind === 'option').length,
    }));
    const filtered = computed(() => {
      const q = query.value.trim().toUpperCase();
      return rows.value.filter(r => (kind.value === 'all' || r.kind === kind.value)
        && (!q || r.title.toUpperCase().includes(q) || r.action.toUpperCase().includes(q)));
    });
    // Month groups, newest first.
    const months = computed(() => {
      const groups = [];
      for (const r of filtered.value) {
        const key = r.date.slice(0, 7);
        let g = groups[groups.length - 1];
        if (!g || g.key !== key) {
          g = { key, label: new Date(r.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), rows: [] };
          groups.push(g);
        }
        g.rows.push(r);
      }
      return groups;
    });
    const totals = computed(() => {
      const realized = filtered.value.filter(r => r.realized != null);
      return {
        cash: filtered.value.reduce((sum, r) => sum + r.cash, 0),
        realized: realized.length ? realized.reduce((sum, r) => sum + r.realized, 0) : null,
      };
    });

    // A bigger list stays quick: show 100 at a time.
    const PAGE = 100;
    const shown = ref(PAGE);
    watch([kind, query], () => { shown.value = PAGE; });
    const visibleMonths = computed(() => {
      let left = shown.value;
      const out = [];
      for (const g of months.value) {
        if (left <= 0) break;
        out.push({ ...g, rows: g.rows.slice(0, left) });
        left -= g.rows.length;
      }
      return out;
    });

    const actionClass = r => (r.action === 'Expired' ? 'expired' : r.cash > 0 ? 'in' : r.cash < 0 ? 'out' : '');

    return {
      KINDS, kind, query, rows, counts, filtered, visibleMonths, totals, shown, PAGE, actionClass,
      formatUSD, formatPrice, formatDate, changeClass, signedUSD, formatQty: n => sharesFormat.format(n),
    };
  },
  template: `
    <div class="card activity-card">
      <div class="activity-head">
        <div class="note-chips" role="group" aria-label="Show">
          <button v-for="k in KINDS" :key="k.id" type="button" class="note-chip" :class="{ selected: kind === k.id }"
                  :aria-pressed="kind === k.id" @click="kind = k.id">
            {{ k.label }} <span class="note-chip-count">{{ counts[k.id] }}</span>
          </button>
        </div>
        <input type="search" class="activity-search" v-model="query" placeholder="Filter by ticker, contract or type"
               aria-label="Filter activity" autocomplete="off" />
      </div>

      <p class="text-muted text-sm activity-empty" v-if="!rows.length">
        No trades yet. Purchases, sales and option trades you record on a stock's Portfolio tab show up here.
      </p>
      <p class="text-muted text-sm activity-empty" v-else-if="!filtered.length">No trades match.</p>

      <template v-else>
        <p class="activity-totals text-sm">
          {{ filtered.length }} trade{{ filtered.length === 1 ? '' : 's' }} ·
          net cash flow <strong :class="changeClass(totals.cash)">{{ signedUSD(totals.cash) }}</strong>
          <template v-if="totals.realized != null"> · realized G/L <strong :class="changeClass(totals.realized)">{{ signedUSD(totals.realized) }}</strong></template>
        </p>
        <section class="activity-month" v-for="g in visibleMonths" :key="g.key" :aria-label="g.label">
          <h4 class="activity-month-head">{{ g.label }}</h4>
          <ul class="activity-list">
            <li class="activity-row" v-for="r in g.rows" :key="r.id">
              <span class="activity-date">{{ formatDate(r.date + 'T12:00:00') }}</span>
              <span class="activity-what">
                <span class="activity-action" :class="actionClass(r)">{{ r.action }}</span>
                <span class="activity-title">{{ r.title }}</span>
                <span class="activity-closed" v-if="r.closed" title="This position has been closed">closed</span>
                <span class="activity-detail text-muted">
                  {{ formatQty(r.quantity) }} {{ r.unit }} at {{ formatPrice(r.price) }}<template v-if="r.via"> · {{ r.via }}</template>
                </span>
              </span>
              <span class="activity-num">
                <span class="activity-label">Cash</span>
                <span :class="changeClass(r.cash)">{{ r.cash ? signedUSD(r.cash) : '—' }}</span>
              </span>
              <span class="activity-num">
                <template v-if="r.realized != null">
                  <span class="activity-label">Realized</span>
                  <span :class="changeClass(r.realized)">{{ signedUSD(r.realized) }}</span>
                </template>
              </span>
            </li>
          </ul>
        </section>
        <button type="button" class="activity-more" v-if="filtered.length > shown" @click="shown += PAGE">
          Show more ({{ filtered.length - shown }} older)
        </button>
      </template>
    </div>
  `,
};
