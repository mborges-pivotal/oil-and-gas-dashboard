const { ref, computed, watch } = Vue;
import HistoryChart from './HistoryChart.js';
import { fetchPriceHistory } from '../services/yahooFinance.js';
import { formatPct, formatDate } from '../utils/formatters.js';

/**
 * A portfolio's all-time gain (%) over time — Account → Portfolios → a
 * portfolio. At each point: (market value − cost) ÷ cost of the stocks and
 * funds held then, rebuilt from their trades and daily closes (Yahoo). The
 * range buttons pick the span shown; 1D uses today's 5-minute prices.
 * Positions entered as totals (no trades) count as held throughout; cash
 * holdings and option contracts aren't charted.
 */
const RANGES = [
  { id: '1D',  label: '1D' },
  { id: '1W',  label: '1W',  days: 7 },
  { id: '1M',  label: '1M',  months: 1 },
  { id: 'YTD', label: 'YTD', ytd: true },
  { id: '1Y',  label: '1Y',  months: 12 },
  { id: 'ALL', label: 'All-Time', all: true },
];

const iso = d => d.toISOString().slice(0, 10);
function monthsBefore(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - n);
  return iso(d);
}

export default {
  name: 'PortfolioChart',
  components: { HistoryChart },
  props: {
    portfolio: Object,           // { portfolio: { SYM: position } }
    intraday: Object,            // symbol → { series: [{ period, value }], previousClose }
    quotes: Object,              // symbol → quote (for the 1D fallback price)
    isCash: { type: Function, default: () => false },
  },
  setup(props) {
    const range = ref('ALL');
    const histories = ref({});   // symbol → { dates, close }
    const loading = ref(false);
    const error = ref(null);

    // Charted holdings: stocks and funds (cash excluded).
    const holdings = computed(() => Object.entries(props.portfolio?.portfolio ?? {})
      .filter(([sym, p]) => p?.quantity > 0 && !props.isCash(sym))
      .map(([sym, p]) => ({ sym, ...p })));
    const symbols = computed(() => holdings.value.map(h => h.sym).sort().join(','));

    watch(symbols, async () => {
      error.value = null;
      const need = holdings.value.map(h => h.sym).filter(s => !histories.value[s]);
      if (!need.length) return;
      loading.value = true;
      const got = await Promise.allSettled(need.map(s => fetchPriceHistory(s)));
      const next = { ...histories.value };
      got.forEach((r, i) => { if (r.status === 'fulfilled') next[need[i]] = r.value; });
      if (got.every(r => r.status === 'rejected')) error.value = 'Price history unavailable right now.';
      histories.value = next;
      loading.value = false;
    }, { immediate: true });

    // Each holding's trades as dated quantity/cost changes — or, when the
    // trades don't add up to the position (entered or edited as a total),
    // the position as held throughout.
    const plans = computed(() => holdings.value.map(h => {
      const txs = [...(h.transactions ?? [])].sort((a, b) => a.date.localeCompare(b.date));
      // Sales and moves to another portfolio take shares out; purchases and moves in add them.
      const out = t => t.type === 'sell' || t.type === 'transfer-out';
      const net = txs.reduce((q, t) => q + (out(t) ? -t.quantity : t.quantity), 0);
      const replay = txs.length > 0 && Math.abs(net - h.quantity) < 1e-6;
      return { sym: h.sym, replay, txs, quantity: h.quantity, avgCost: h.avgCost };
    }));
    const firstTrade = computed(() => plans.value.filter(p => p.replay).map(p => p.txs[0].date).sort()[0] ?? null);

    // Daily series of all-time gain %.
    const daily = computed(() => {
      const hs = histories.value;
      const usable = plans.value.filter(p => hs[p.sym]?.dates?.length);
      if (!usable.length) return [];
      const lastDay = usable.map(p => hs[p.sym].dates.at(-1)).sort().at(-1);
      const r = RANGES.find(x => x.id === range.value);
      let start;
      if (r.all) start = firstTrade.value ?? monthsBefore(lastDay, 12);
      else if (r.ytd) start = `${Number(lastDay.slice(0, 4)) - 1}-12-31`;
      else if (r.days) start = iso(new Date(Date.parse(lastDay + 'T12:00:00Z') - r.days * 86400000));
      else start = monthsBefore(lastDay, r.months);
      // Trading days in the window (from any holding's history).
      const days = [...new Set(usable.flatMap(p => hs[p.sym].dates.filter(d => d >= start)))].sort();
      const state = usable.map(p => ({ p, h: hs[p.sym], i: 0, qty: p.replay ? 0 : p.quantity, cost: p.replay ? 0 : p.quantity * p.avgCost, t: 0, px: null }));
      const out = [];
      for (const day of days) {
        let value = 0, cost = 0;
        for (const s of state) {
          while (s.i < s.h.dates.length && s.h.dates[s.i] <= day) { s.px = s.h.close[s.i]; s.i++; }
          if (s.p.replay) {
            while (s.t < s.p.txs.length && s.p.txs[s.t].date <= day) {
              const tx = s.p.txs[s.t++];
              if (tx.type === 'sell' || tx.type === 'transfer-out') { // leaves at the average cost
                const avg = s.qty > 0 ? s.cost / s.qty : 0;
                s.qty -= tx.quantity;
                s.cost -= tx.quantity * avg;
              } else {
                s.qty += tx.quantity;
                s.cost += tx.quantity * tx.price;
              }
            }
          }
          if (s.qty > 1e-9 && s.px != null) { value += s.qty * s.px; cost += s.cost; }
        }
        if (cost > 0) out.push({ period: day, value: ((value - cost) / cost) * 100 });
      }
      return out;
    });

    // Today, every 5 minutes: current holdings at each moment's price.
    const intradaySeries = computed(() => {
      const items = holdings.value.map(h => ({ h, s: props.intraday?.[h.sym] })).filter(x => x.s?.series?.length);
      if (!items.length) return [];
      const cost = holdings.value.reduce((sum, h) => sum + h.quantity * h.avgCost, 0);
      if (!(cost > 0)) return [];
      const times = [...new Set(items.flatMap(x => x.s.series.map(p => p.period)))].sort();
      const idx = items.map(() => 0);
      const last = items.map(x => x.s.previousClose ?? props.quotes?.[x.h.sym]?.previousClose ?? null);
      // Holdings without intraday data count at their latest price.
      const fixed = holdings.value.filter(h => !items.some(x => x.h === h))
        .reduce((sum, h) => sum + h.quantity * (props.quotes?.[h.sym]?.price ?? h.avgCost), 0);
      return times.map(t => {
        let value = fixed;
        items.forEach((x, k) => {
          while (idx[k] < x.s.series.length && x.s.series[idx[k]].period <= t) { last[k] = x.s.series[idx[k]].value; idx[k]++; }
          value += x.h.quantity * (last[k] ?? x.h.avgCost);
        });
        return { period: t, value: ((value - cost) / cost) * 100 };
      });
    });

    const data = computed(() => (range.value === '1D' ? intradaySeries.value : daily.value));
    const current = computed(() => data.value.at(-1)?.value ?? null);

    return { RANGES, range, data, loading, error, current, holdings, firstTrade, formatPct, formatDate, pctFmt: v => formatPct(v) };
  },
  template: `
    <div class="card pf-chart-card">
      <div class="pf-chart-head">
        <div>
          <div class="card-title" style="margin-bottom:2px" title="Gain over the money invested in stocks and funds">All-time gain</div>
          <div class="pf-chart-value" :class="current == null ? '' : current >= 0 ? 'positive' : 'negative'">{{ current != null ? formatPct(current) : '—' }}</div>
        </div>
        <div class="range-btn-group pf-chart-ranges" role="group" aria-label="Chart range">
          <button v-for="r in RANGES" :key="r.id" type="button" class="range-btn" :class="{ active: range === r.id }"
                  :aria-pressed="range === r.id" @click="range = r.id">{{ r.label }}</button>
        </div>
      </div>
      <p class="text-muted text-sm" v-if="!holdings.length" style="margin:12px 0 0">No stocks or funds to chart yet.</p>
      <div class="notice error" v-else-if="error && !data.length">{{ error }}</div>
      <div class="skeleton" style="height:220px;margin-top:12px" v-else-if="loading && !data.length"></div>
      <p class="text-muted text-sm" v-else-if="!data.length" style="margin:12px 0 0">
        {{ range === '1D' ? "No intraday prices yet today." : 'Not enough history for this range.' }}
      </p>
      <div v-else style="margin-top:8px">
        <HistoryChart :data="data" :intraday="range === '1D'" :format-value="pctFmt" change-in-points />
      </div>
      <p class="text-muted text-sm pf-chart-note">
        Gain vs. cost of the stocks and funds held at each point, rebuilt from your trades<template v-if="firstTrade"> (first on {{ formatDate(firstTrade + 'T12:00:00') }})</template>.
        Positions entered as totals count as held throughout; cash and options aren't charted.
      </p>
    </div>
  `,
};
