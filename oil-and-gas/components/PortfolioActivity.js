const { ref, reactive, computed, watch, onMounted } = Vue;
import { formatUSD, formatPrice, formatDate, changeClass } from '../utils/formatters.js';
import { MULTIPLIER, optionLabel } from '../utils/options.js';
import { createPost } from '../services/social.js';

/**
 * Account → Transactions: every recorded trade in every portfolio (or one, picked
 * in the filter), newest first, grouped by month — stock purchases and
 * sales, and option opens, closes and expirations — from open positions and
 * Closed positions alike. Built from the transactions saved on each position
 * (each portfolio's portfolio / optionPositions / closedPositions), so it's read-only:
 * trades are added, closed or deleted on the position itself. Positions
 * entered as a total (quantity × average cost) have no trades to list.
 *
 * Share update: pick buys and sells from one portfolio and add a message →
 * an update in Inbox → Activity → You, and (public portfolio) in Following
 * for everyone following it. Only the action and ticker are shared — never
 * quantities, prices or amounts.
 */
const MAX_MESSAGE = 500;
const MAX_TRADES = 20;
const KINDS = [
  { id: 'all',     label: 'All' },
  { id: 'stock',   label: 'Stocks' },
  { id: 'option',  label: 'Options' },
  { id: 'cash',    label: 'Cash' },
  { id: 'transfer', label: 'Transfers' },
];
const cashName = sym => (sym === 'CASH' ? 'Account cash' : sym);

const sharesFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const signedUSD = v => (v > 0 ? '+' : v < 0 ? '−' : '') + formatUSD(Math.abs(v));

export default {
  name: 'PortfolioActivity',
  props: {
    portfolios: { type: Array, default: () => [] }, accountCash: { type: Object, default: null }, transfers: { type: Array, default: () => [] },
    startShare: Boolean, // open in Share update mode
  },
  emits: ['go-activity'],
  setup(props, { emit }) {
    const kind = ref('all');
    const query = ref('');
    const pfFilter = ref(''); // '' = all portfolios

    // One row per trade: { id, date, kind, action, symbol, title, quantity, unit, price,
    //   cash (signed flow: − paid, + received), realized, via, closed }
    const rows = computed(() => {
      const out = [];
      let pf = null; // the portfolio being read (set in the loop below)
      const stockRows = (symbol, txs, closed) => {
        for (const t of txs ?? []) {
          if (t.type === 'transfer-in' || t.type === 'transfer-out') continue; // listed once, as the move below
          const sell = t.type === 'sell';
          out.push({
            portfolio: pf.name, portfolioId: pf.id,
            id: `s-${pf.id}-${symbol}-${t.id}`, date: t.date, kind: 'stock', action: sell ? 'Sell' : 'Buy',
            symbol, title: symbol, quantity: t.quantity, unit: 'shares', price: t.price,
            cash: (sell ? 1 : -1) * t.quantity * t.price, realized: sell ? t.realized : null,
            via: t.paidFrom ? `from ${cashName(t.paidFrom)}` : t.depositTo ? `to ${cashName(t.depositTo)}` : '', closed,
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
            portfolio: pf.name, portfolioId: pf.id,
            id: `o-${pf.id}-${occ}-${t.id}`, date: t.date, kind: 'option', action, symbol: o.underlying,
            title: optionLabel(occ), quantity: t.quantity, unit: t.quantity === 1 ? 'contract' : 'contracts', price: t.price,
            cash: (inflow ? 1 : -1) * t.quantity * m * t.price, realized: open ? null : t.realized,
            via: t.cash ? `${t.cashDir === 'out' ? 'from' : 'to'} ${cashName(t.cash)}` : '', closed,
          });
        }
      };
      for (const p of props.portfolios) {
        if (pfFilter.value && p.id !== pfFilter.value) continue;
        pf = p;
        for (const [sym, pos] of Object.entries(p.portfolio ?? {})) stockRows(sym, pos?.transactions, false);
        for (const [occ, pos] of Object.entries(p.optionPositions ?? {})) if (pos) optionRows(occ, pos, pos.transactions, false);
        for (const c of p.closedPositions ?? []) {
          if (c.kind === 'option') optionRows(c.symbol, c.option, c.transactions, true);
          else stockRows(c.symbol, c.transactions, true);
        }
      }
      // Moves between portfolios — shown for either portfolio when one is picked.
      for (const m of props.transfers ?? []) {
        if (pfFilter.value && m.fromId !== pfFilter.value && m.toId !== pfFilter.value) continue;
        out.push({
          id: `m-${m.id}`, date: m.date, kind: 'transfer', action: 'Transfer', symbol: m.symbol, title: m.symbol,
          quantity: m.quantity, unit: m.quantity === 1 ? 'share' : 'shares', price: m.avgCost, priceLabel: 'avg',
          cash: 0, realized: null, closed: false, portfolio: null,
          via: `${m.fromName} → ${m.toName}${m.whole ? ' (whole position, with its trades)' : ''}${m.options?.length ? ' · with ' + m.options.join(', ') : ''}`,
        });
      }
      // Deposits into the account's cash (not in any portfolio — shown unless one is picked).
      if (!pfFilter.value) {
        for (const d of props.accountCash?.deposits ?? []) {
          out.push({
            id: `d-${d.id}`, date: d.date, kind: 'cash', action: 'Deposit', symbol: '', title: 'Account cash',
            quantity: null, unit: '', price: null, cash: d.amount, realized: null,
            via: `from ${d.bank} ••${d.last4}`, closed: false, portfolio: null,
          });
        }
      }
      return out.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    });

    const counts = computed(() => ({
      all: rows.value.length,
      stock: rows.value.filter(r => r.kind === 'stock').length,
      option: rows.value.filter(r => r.kind === 'option').length,
      cash: rows.value.filter(r => r.kind === 'cash').length,
      transfer: rows.value.filter(r => r.kind === 'transfer').length,
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
    watch([kind, query, pfFilter], () => { shown.value = PAGE; });
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

    // ── Share update ──
    // share: { portfolioId (locked by the first pick), picked: row id → { action, symbol }, message, busy, error }
    const share = ref(null);
    const shared = ref(null); // { portfolioPublic } after posting
    let before = null; // the filters to restore afterwards
    function startShare() {
      shared.value = null;
      before = { kind: kind.value, pfFilter: pfFilter.value };
      kind.value = 'stock';
      share.value = reactive({ portfolioId: pfFilter.value || (props.portfolios.length === 1 ? props.portfolios[0].id : null), picked: {}, message: '', busy: false, error: null });
      if (share.value.portfolioId) pfFilter.value = share.value.portfolioId;
    }
    function endShare() {
      share.value = null;
      if (before) { kind.value = before.kind; pfFilter.value = before.pfFilter; before = null; }
    }
    onMounted(() => { if (props.startShare) startShare(); });
    watch(() => props.startShare, on => { if (on && !share.value) startShare(); });
    // A portfolio picked in the filter while sharing is the one shared from.
    watch(pfFilter, id => {
      if (!share.value || id === share.value.portfolioId) return;
      share.value.portfolioId = id || null;
      share.value.picked = {};
    });
    const shareable = r => r.kind === 'stock' && (r.action === 'Buy' || r.action === 'Sell')
      && (!share.value?.portfolioId || r.portfolioId === share.value.portfolioId);
    function togglePick(r) {
      const s = share.value;
      if (!s || !shareable(r)) return;
      if (s.picked[r.id]) { delete s.picked[r.id]; return; }
      if (!s.portfolioId) { s.portfolioId = r.portfolioId; pfFilter.value = r.portfolioId; }
      s.picked[r.id] = { action: r.action === 'Sell' ? 'sell' : 'buy', symbol: r.symbol };
    }
    // The update's trades: each action + ticker once, in the order picked.
    const shareTrades = computed(() => {
      const seen = new Set();
      return Object.values(share.value?.picked ?? {}).filter(t => {
        const k = t.action + ':' + t.symbol;
        return !seen.has(k) && seen.add(k);
      });
    });
    const sharePf = computed(() => props.portfolios.find(p => p.id === share.value?.portfolioId) ?? null);
    async function postShare() {
      const s = share.value;
      if (!sharePf.value || !shareTrades.value.length || s.busy) return;
      s.busy = true;
      s.error = null;
      try {
        await createPost(sharePf.value.id, shareTrades.value, s.message.trim());
        shared.value = { portfolioPublic: sharePf.value.visibility === 'public', name: sharePf.value.name };
        endShare();
      } catch (e) {
        s.error = e.message;
        s.busy = false;
      }
    }

    const actionClass = r => (r.action === 'Expired' ? 'expired' : r.kind === 'transfer' ? 'transfer' : r.cash > 0 ? 'in' : r.cash < 0 ? 'out' : '');

    return {
      share, shared, startShare, endShare, shareable, togglePick, shareTrades, sharePf, postShare, MAX_MESSAGE, MAX_TRADES, emit,
      KINDS, kind, query, pfFilter, rows, counts, filtered, visibleMonths, totals, shown, PAGE, actionClass,
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
        <div class="activity-filters">
          <button type="button" class="primary share-btn" v-if="!share" :disabled="!rows.some(r => r.kind === 'stock')" @click="startShare"
                  title="Share buys and sells (action and ticker only) as an update">Share update</button>
          <select v-if="portfolios.length > 1" v-model="pfFilter" aria-label="Portfolio">
            <option value="" :disabled="!!share">{{ share ? 'Pick a portfolio' : 'All portfolios' }}</option>
            <option v-for="p in portfolios" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <input type="search" class="activity-search" v-model="query" placeholder="Filter by ticker, contract or type"
                 aria-label="Filter activity" autocomplete="off" />
        </div>
      </div>

      <div class="notice share-done" v-if="shared && !share">
        ✓ Shared from {{ shared.name }} — it's in <a href="#" @click.prevent="emit('go-activity')">Inbox → Activity → You</a><template v-if="shared.portfolioPublic"> and in Following for everyone following it</template>.
        <button type="button" class="link-button" aria-label="Dismiss" @click="shared = null">✕</button>
      </div>

      <!-- Share update: the composer; rows below get checkboxes -->
      <form class="share-composer" v-if="share" @submit.prevent="postShare" aria-label="Share update">
        <div class="share-composer-title">
          <strong>Share update</strong>
          <span class="text-muted text-sm"> — tick the buys and sells to share{{ portfolios.length > 1 ? ', from one portfolio' : '' }}. Only the action and ticker are shared, never amounts.</span>
        </div>
        <div class="post-head share-preview">
          <div class="post-trades" v-if="shareTrades.length">
            <span v-for="t in shareTrades" :key="t.action + t.symbol" class="post-trade">
              <span class="post-action" :class="t.action">{{ t.action === 'buy' ? 'BUY' : 'SELL' }}</span>
              <span class="post-ticker">{{ t.symbol }}</span>
            </span>
          </div>
          <div class="text-muted text-sm" v-else>No trades picked yet.</div>
          <div class="post-meta" v-if="sharePf"><span class="post-handle">@{{ sharePf.id }}</span> <span class="text-muted text-sm">{{ sharePf.name }}</span></div>
        </div>
        <textarea v-model="share.message" rows="3" :maxlength="MAX_MESSAGE" placeholder="Add a message (optional) — why you made the move"
                  aria-label="Message"></textarea>
        <div class="share-composer-foot">
          <span class="text-sm" :class="sharePf && sharePf.visibility !== 'public' ? 'share-private' : 'text-muted'">
            <template v-if="!sharePf">Pick a portfolio (or tick a trade).</template>
            <template v-else-if="sharePf.visibility === 'public'">🌐 Goes to Inbox → Activity → You and to everyone following @{{ sharePf.id }}.</template>
            <template v-else>🔒 {{ sharePf.name }} is private — only you will see this (Inbox → Activity → You). Make it public to share with followers.</template>
          </span>
          <span class="text-muted text-sm" v-if="share.message.length > MAX_MESSAGE - 100">{{ MAX_MESSAGE - share.message.length }} left</span>
          <span class="negative text-sm" v-if="shareTrades.length > MAX_TRADES">At most {{ MAX_TRADES }} trades</span>
          <span class="share-composer-buttons">
            <button type="button" @click="endShare">Cancel</button>
            <button type="submit" class="primary" :disabled="!sharePf || !shareTrades.length || shareTrades.length > MAX_TRADES || share.busy">
              {{ share.busy ? 'Posting…' : 'Post' }}
            </button>
          </span>
        </div>
        <div class="notice error" v-if="share.error" style="margin:8px 0 0">{{ share.error }}</div>
      </form>

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
            <li class="activity-row" v-for="r in g.rows" :key="r.id"
                :class="{ sharing: share, picked: share?.picked[r.id], unpickable: share && !shareable(r) }"
                @click="share && togglePick(r)">
              <input type="checkbox" class="share-check" v-if="share" :checked="!!share.picked[r.id]" :disabled="!shareable(r)"
                     :aria-label="'Share ' + r.action + ' ' + r.title" @click.stop="togglePick(r)" />
              <span class="activity-date">{{ formatDate(r.date + 'T12:00:00') }}</span>
              <span class="activity-what">
                <span class="activity-action" :class="actionClass(r)">{{ r.action }}</span>
                <span class="activity-title">{{ r.title }}</span>
                <span class="activity-closed" v-if="r.closed" title="This position has been closed">closed</span>
                <span class="activity-portfolio" v-if="portfolios.length > 1 && !pfFilter && r.portfolio">{{ r.portfolio }}</span>
                <span class="activity-detail text-muted">
                  <template v-if="r.quantity != null">{{ formatQty(r.quantity) }} {{ r.unit }} at {{ formatPrice(r.price) }}{{ r.priceLabel ? ' ' + r.priceLabel : '' }}<template v-if="r.via"> · </template></template>{{ r.via }}
                </span>
              </span>
              <span class="activity-num">
                <span class="activity-label">Cash</span>
                <span :class="r.cash ? changeClass(r.cash) : 'text-muted'">{{ r.cash ? signedUSD(r.cash) : '—' }}</span>
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
