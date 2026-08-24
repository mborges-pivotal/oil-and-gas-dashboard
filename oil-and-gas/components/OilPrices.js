const { ref, reactive, onMounted, onUnmounted, computed } = Vue;
import { fetchQuote } from '../services/yahooFinance.js';
import { calcSpread } from '../utils/spread.js';
import { formatUSD, formatPct, changeClass } from '../utils/formatters.js';

const SYMBOL_LABELS = {
  'BZ=F': 'Brent Crude',
  'CL=F': 'WTI Crude',
  'NG=F': 'Natural Gas',
  'HO=F': 'Heating Oil',
  'RB=F': 'RBOB Gasoline',
};

export default {
  name: 'OilPrices',
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

    onMounted(() => {
      fetchAll();
      const interval = Math.max(30, props.config.ui?.refreshIntervalSeconds ?? 60) * 1000;
      refreshTimer = setInterval(fetchAll, interval);
    });
    onUnmounted(() => clearInterval(refreshTimer));

    return { prices, symbols, spreadA, spreadB, spread, spreadLabel, lastUpdated, SYMBOL_LABELS, formatUSD, formatPct, changeClass };
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
