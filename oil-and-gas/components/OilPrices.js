const { ref, reactive, onMounted, onUnmounted, computed, watch } = Vue;
import { fetchQuote, fetchChart } from '../services/yahooFinance.js';
import { calcSpread } from '../utils/spread.js';
import { formatUSD, formatPct, changeClass } from '../utils/formatters.js';
import { RANGE_OPTIONS, cutoffDateFor } from '../utils/dateRange.js';
import DualLineChart from './DualLineChart.js';

const SYMBOL_LABELS = {
  'BZ=F': 'Brent Crude',
  'CL=F': 'WTI Crude',
  'NG=F': 'Natural Gas',
  'HO=F': 'Heating Oil',
  'RB=F': 'RBOB Gasoline',
};

// Base window fetched once per symbol pair; range buttons then filter this
// client-side (same pattern as Gas Prices' historical chart), so switching
// ranges doesn't re-hit the API.
const SPREAD_HISTORY_FETCH_RANGE = '5y';

export default {
  name: 'OilPrices',
  components: { DualLineChart },
  props: ['config'],
  setup(props) {
    const prices = reactive({});       // symbol → { price, change, pctChange, loading, error }
    const spreadA = ref(props.config.oilIndexes?.defaultSpreadA ?? 'BZ=F');
    const spreadB = ref(props.config.oilIndexes?.defaultSpreadB ?? 'CL=F');
    const lastUpdated = ref(null);
    let refreshTimer = null;

    const symbols = computed(() => props.config.oilIndexes?.symbols ?? []);

    const spread = computed(() => {
      const a = prices[spreadA.value];
      const b = prices[spreadB.value];
      if (!a?.price || !b?.price) return null;
      return calcSpread(a.price, b.price);
    });

    const spreadLabel = computed(() =>
      `${SYMBOL_LABELS[spreadA.value] ?? spreadA.value} − ${SYMBOL_LABELS[spreadB.value] ?? spreadB.value}`
    );

    async function fetchAll() {
      await Promise.all(symbols.value.map(async (sym) => {
        if (!prices[sym]) prices[sym] = { price: null, change: null, pctChange: null, loading: true, error: null };
        else prices[sym].loading = true;
        try {
          const q = await fetchQuote(sym);
          prices[sym] = { ...q, loading: false, error: null };
        } catch (e) {
          prices[sym] = { price: null, change: null, pctChange: null, loading: false, error: e.message };
        }
      }));
      lastUpdated.value = new Date().toLocaleTimeString();
    }

    // ── Spread history ────────────────────────────────────────────────────
    const spreadHistorySeries = ref([]); // ascending { period, a, b } — a/b are actual closes
    const spreadHistoryRange = ref('1Y');
    const spreadHistoryLoading = ref(true);
    const spreadHistoryError = ref(null);
    const showSpreadHistoryTable = ref(false);

    const filteredSpreadHistory = computed(() => {
      const cutoff = cutoffDateFor(spreadHistoryRange.value);
      return spreadHistorySeries.value
        .filter(r => new Date(r.period) >= cutoff)
        .slice()
        .sort((a, b) => a.period.localeCompare(b.period));
    });

    function dateKeyFromEpoch(ts) {
      return new Date(ts * 1000).toISOString().slice(0, 10);
    }

    // Fetches daily closes for both legs and aligns them by trading date —
    // futures on different underlyings can have slightly different trading
    // calendars, so index-based pairing would silently misalign points.
    async function fetchSpreadHistory() {
      spreadHistoryLoading.value = true;
      spreadHistoryError.value = null;
      try {
        const [a, b] = await Promise.all([
          fetchChart(spreadA.value, SPREAD_HISTORY_FETCH_RANGE, '1d'),
          fetchChart(spreadB.value, SPREAD_HISTORY_FETCH_RANGE, '1d'),
        ]);
        const bByDate = new Map();
        b.timestamps.forEach((ts, i) => {
          const close = b.closes[i];
          if (close != null) bByDate.set(dateKeyFromEpoch(ts), close);
        });
        const series = [];
        a.timestamps.forEach((ts, i) => {
          const closeA = a.closes[i];
          if (closeA == null) return;
          const key = dateKeyFromEpoch(ts);
          const closeB = bByDate.get(key);
          if (closeB == null) return;
          series.push({ period: key, a: closeA, b: closeB });
        });
        spreadHistorySeries.value = series;
      } catch (e) {
        spreadHistoryError.value = e.message;
      } finally {
        spreadHistoryLoading.value = false;
      }
    }

    watch([spreadA, spreadB], fetchSpreadHistory);

    onMounted(() => {
      fetchAll();
      fetchSpreadHistory();
      const interval = Math.max(30, props.config.ui?.refreshIntervalSeconds ?? 60) * 1000;
      refreshTimer = setInterval(fetchAll, interval);
    });
    onUnmounted(() => clearInterval(refreshTimer));

    return {
      prices, symbols, spreadA, spreadB, spread, spreadLabel, lastUpdated, SYMBOL_LABELS,
      spreadHistorySeries, spreadHistoryRange, spreadHistoryLoading, spreadHistoryError,
      showSpreadHistoryTable, filteredSpreadHistory, RANGE_OPTIONS,
      formatUSD, formatPct, changeClass,
    };
  },
  template: `
    <div>
      <div class="flex-between mb-16">
        <div class="section-header" style="margin-bottom:0">Oil Price Indexes</div>
        <div class="text-muted text-sm" v-if="lastUpdated">Updated {{ lastUpdated }}</div>
      </div>

      <!-- Price Cards -->
      <div class="price-grid">
        <div class="price-card" v-for="sym in symbols" :key="sym">
          <div class="label">{{ SYMBOL_LABELS[sym] ?? sym }}</div>
          <template v-if="prices[sym]?.loading && !prices[sym]?.price">
            <div class="skeleton" style="width:80%;height:28px;margin-top:4px"></div>
            <div class="skeleton" style="width:50%;height:14px;margin-top:6px"></div>
          </template>
          <template v-else-if="prices[sym]?.error">
            <div class="text-muted text-sm">Unavailable</div>
          </template>
          <template v-else>
            <div class="price">{{ formatUSD(prices[sym]?.price) }}</div>
            <div class="change" :class="changeClass(prices[sym]?.change)">
              {{ formatUSD(prices[sym]?.change) }} ({{ formatPct(prices[sym]?.pctChange) }})
            </div>
          </template>
        </div>
      </div>

      <!-- Spread Calculator -->
      <div class="card mb-24">
        <div class="card-title">Spread Calculator</div>
        <div class="spread-widget">
          <div>
            <label>Index A</label>
            <select v-model="spreadA">
              <option v-for="sym in symbols" :key="sym" :value="sym">{{ SYMBOL_LABELS[sym] ?? sym }}</option>
            </select>
          </div>
          <div class="spread-vs">−</div>
          <div>
            <label>Index B</label>
            <select v-model="spreadB">
              <option v-for="sym in symbols" :key="sym" :value="sym">{{ SYMBOL_LABELS[sym] ?? sym }}</option>
            </select>
          </div>
          <div style="margin-left:auto">
            <div class="spread-label">{{ spreadLabel }}</div>
            <div v-if="spread" class="spread-result" :class="changeClass(spread.value)">
              {{ formatUSD(spread.value) }}
              <span class="text-muted text-sm" style="font-size:13px"> ({{ formatPct(spread.pct) }})</span>
            </div>
            <div v-else class="text-muted text-sm">Loading…</div>
          </div>
        </div>
      </div>

      <!-- Spread History -->
      <div class="card mb-24">
        <div class="flex-between mb-16" style="flex-wrap:wrap;gap:12px">
          <div class="card-title" style="margin-bottom:0">Spread History</div>
          <div class="chart-filters">
            <div class="range-btn-group">
              <button
                v-for="r in RANGE_OPTIONS" :key="r.id"
                class="range-btn" :class="{ active: spreadHistoryRange === r.id }"
                @click="spreadHistoryRange = r.id"
              >{{ r.label }}</button>
            </div>
          </div>
        </div>

        <div class="notice error" v-if="spreadHistoryError">Failed to load spread history: {{ spreadHistoryError }}</div>
        <template v-else-if="spreadHistoryLoading">
          <div class="skeleton" style="width:100%;height:260px"></div>
        </template>
        <template v-else-if="filteredSpreadHistory.length">
          <DualLineChart :data="filteredSpreadHistory"
            :label-a="SYMBOL_LABELS[spreadA] ?? spreadA" :label-b="SYMBOL_LABELS[spreadB] ?? spreadB" />
          <p class="text-muted text-sm" style="margin-top:10px">
            Shaded green where {{ SYMBOL_LABELS[spreadA] ?? spreadA }} traded above {{ SYMBOL_LABELS[spreadB] ?? spreadB }}; red where below.
          </p>
          <div style="margin-top:4px">
            <button @click="showSpreadHistoryTable = !showSpreadHistoryTable">
              {{ showSpreadHistoryTable ? 'Hide' : 'View' }} as table
            </button>
          </div>
          <table class="data-table" style="margin-top:10px" v-if="showSpreadHistoryTable">
            <thead>
              <tr>
                <th>Date</th>
                <th class="num">{{ SYMBOL_LABELS[spreadA] ?? spreadA }}</th>
                <th class="num">{{ SYMBOL_LABELS[spreadB] ?? spreadB }}</th>
                <th class="num">Spread</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in [...filteredSpreadHistory].reverse()" :key="row.period">
                <td>{{ row.period }}</td>
                <td class="num">{{ formatUSD(row.a) }}</td>
                <td class="num">{{ formatUSD(row.b) }}</td>
                <td class="num" :class="changeClass(row.a - row.b)">{{ formatUSD(row.a - row.b) }}</td>
              </tr>
            </tbody>
          </table>
        </template>
        <div class="notice text-sm" v-else>No spread history available for this range.</div>
      </div>

      <!-- Data Table -->
      <div class="card">
        <table class="data-table">
          <thead>
            <tr>
              <th>Index</th>
              <th>Symbol</th>
              <th class="num">Price</th>
              <th class="num">Change</th>
              <th class="num">% Change</th>
              <th class="num">Prev Close</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="sym in symbols" :key="sym">
              <td>{{ SYMBOL_LABELS[sym] ?? sym }}</td>
              <td class="text-muted">{{ sym }}</td>
              <td class="num">{{ formatUSD(prices[sym]?.price) }}</td>
              <td class="num" :class="changeClass(prices[sym]?.change)">{{ formatUSD(prices[sym]?.change) }}</td>
              <td class="num" :class="changeClass(prices[sym]?.pctChange)">{{ formatPct(prices[sym]?.pctChange) }}</td>
              <td class="num text-muted">{{ formatUSD(prices[sym]?.previousClose) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="notice text-sm" style="margin-top:12px">
        Data sourced from Yahoo Finance (unofficial API). Prices may be delayed 15–20 minutes.
      </div>
    </div>
  `,
};
