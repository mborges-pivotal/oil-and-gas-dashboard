const { ref, reactive, onMounted, onUnmounted, computed, watch } = Vue;
import { fetchQuote, fetchChart } from '../services/yahooFinance.js';
import { fetchGasPrices, fetchDieselPrices, fetchGasPriceHistory } from '../services/eia.js';
import { calcSpread, calcCrackSpread, classifyCrackSpread, DEFAULT_CRACK_SPREAD_THRESHOLDS } from '../utils/spread.js';
import { formatUSD, formatPct, formatDate, changeClass } from '../utils/formatters.js';
import { RANGE_OPTIONS, cutoffDateFor } from '../utils/dateRange.js';
import DualLineChart from './DualLineChart.js';
import HistoryChart from './HistoryChart.js';

const SYMBOL_LABELS = {
  'BZ=F': 'Brent Crude',
  'CL=F': 'WTI Crude',
  'NG=F': 'Natural Gas',
  'HO=F': 'Heating Oil',
  'RB=F': 'RBOB Gasoline',
};

// Base window fetched once per symbol pair; range buttons then filter this
// client-side (same pattern as the gas price historical chart), so
// switching ranges doesn't re-hit the API.
const SPREAD_HISTORY_FETCH_RANGE = '5y';

const PRODUCT_LABELS = {
  EPMR: 'Regular',
  EPMM: 'Midgrade',
  EPMP: 'Premium',
  EPM0: 'All Grades Avg',
  EPD2D: 'Diesel (ULSD)',
};

// Product display order
const PRODUCT_ORDER = ['EPMR', 'EPMM', 'EPMP', 'EPM0'];

// Grades selectable for the history chart, in dropdown order
const HISTORY_GRADES = ['EPMR', 'EPM0', 'EPMM', 'EPMP', 'EPD2D'];

const HISTORY_MAX_WEEKS = 270; // ~5 years + buffer

export default {
  name: 'OilGasMarkets',
  components: { DualLineChart, HistoryChart },
  props: ['config'],
  setup(props) {
    const lastUpdated = ref(null);
    let refreshTimer = null;
    const activeSection = ref('oil'); // 'oil' | 'gas'

    // ── Oil price indexes ───────────────────────────────────────────────────
    const prices = reactive({});       // symbol → { price, change, pctChange, loading, error }
    const spreadA = ref(props.config.oilIndexes?.defaultSpreadA ?? 'BZ=F');
    const spreadB = ref(props.config.oilIndexes?.defaultSpreadB ?? 'CL=F');

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

    async function fetchOilPrices() {
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
    }

    // ── Oil spread history ──────────────────────────────────────────────────
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

    // ── Gas prices + crack spread ───────────────────────────────────────────
    const gasSeries = ref([]);    // raw EIA rows
    const dieselSeries = ref([]); // raw EIA diesel rows
    const gasLoading = ref(true);
    const gasError = ref(null);

    // Crack spread uses wholesale/futures prices (Yahoo Finance), not EIA
    // retail prices — RBOB Gasoline and Heating Oil futures are the standard
    // NYMEX proxies for wholesale gasoline/distillate, both quoted USD/gal
    // like the retail EIA series, so no unit changes are needed downstream.
    // This is independent of the EIA API key.
    const rbobPrice = ref(null);
    const heatingOilPrice = ref(null);
    const wtiPrice = ref(null);
    const crackSpread = ref(null);
    const crackLoading = ref(true);
    const crackError = ref(null);

    // Historical gas price chart state. Defaults to Regular — the grade
    // commonly cited as "the national average gas price" — but any grade
    // (including All Grades Avg) is one click away via the dropdown.
    const historyGrade = ref('EPMR');
    const historyRange = ref('1Y');
    const historySeries = ref([]); // raw EIA rows, desc by period, for historyGrade
    const historyLoading = ref(true);
    const historyError = ref(null);
    const showHistoryTable = ref(false);

    const hasKey = computed(() => !!props.config.eiaApiKey?.trim());

    const crackTier = computed(() => {
      if (crackSpread.value === null) return null;
      const thresholds = props.config.crackSpreadThresholds ?? DEFAULT_CRACK_SPREAD_THRESHOLDS;
      return classifyCrackSpread(crackSpread.value, thresholds);
    });

    // Latest week per product — map: product → { value, period }
    const latestByProduct = computed(() => {
      const map = {};
      for (const row of gasSeries.value) {
        if (!map[row.product] || row.period > map[row.product].period) {
          map[row.product] = row;
        }
      }
      const latestDiesel = dieselSeries.value[0];
      if (latestDiesel) map['EPD2D'] = latestDiesel;
      return map;
    });

    // historySeries is fetched desc by period; filter by range and flip to
    // ascending for the chart (oldest → newest, left → right).
    const filteredHistory = computed(() => {
      const cutoff = cutoffDateFor(historyRange.value);
      return historySeries.value
        .filter(r => new Date(r.period) >= cutoff)
        .slice()
        .sort((a, b) => a.period.localeCompare(b.period));
    });

    async function fetchRetailGas() {
      if (!hasKey.value) return;
      gasLoading.value = gasSeries.value.length === 0;
      gasError.value = null;
      try {
        const key = props.config.eiaApiKey.trim();
        const [gas, diesel] = await Promise.all([
          fetchGasPrices(key, 12),
          fetchDieselPrices(key, 4),
        ]);
        gasSeries.value = gas;
        dieselSeries.value = diesel;
      } catch (e) {
        gasError.value = e.message;
      } finally {
        gasLoading.value = false;
      }
    }

    async function fetchCrackSpread() {
      crackLoading.value = crackSpread.value === null;
      crackError.value = null;
      try {
        const [rbob, heatingOil, wti] = await Promise.all([
          fetchQuote('RB=F'),
          fetchQuote('HO=F'),
          fetchQuote('CL=F'),
        ]);
        rbobPrice.value = rbob.price;
        heatingOilPrice.value = heatingOil.price;
        wtiPrice.value = wti.price;
        crackSpread.value = calcCrackSpread(rbob.price, heatingOil.price, wti.price);
      } catch (e) {
        crackError.value = e.message;
      } finally {
        crackLoading.value = false;
      }
    }

    // Weekly EIA data doesn't change intra-day, so this is fetched once per
    // grade selection — not on the recurring refresh timer like the crack
    // spread (which tracks live futures) or the retail snapshot.
    async function fetchGasHistory() {
      if (!hasKey.value) return;
      historyLoading.value = true;
      historyError.value = null;
      try {
        const key = props.config.eiaApiKey.trim();
        historySeries.value = await fetchGasPriceHistory(key, historyGrade.value, HISTORY_MAX_WEEKS);
      } catch (e) {
        historyError.value = e.message;
      } finally {
        historyLoading.value = false;
      }
    }

    watch(historyGrade, fetchGasHistory);

    // ── One shared refresh cycle for everything with a live/recurring price ──
    async function refreshAll() {
      await Promise.all([fetchOilPrices(), fetchRetailGas(), fetchCrackSpread()]);
      lastUpdated.value = new Date().toLocaleTimeString();
    }

    onMounted(() => {
      refreshAll();
      fetchSpreadHistory();
      fetchGasHistory();
      const interval = Math.max(30, props.config.ui?.refreshIntervalSeconds ?? 60) * 1000;
      refreshTimer = setInterval(refreshAll, interval);
    });
    onUnmounted(() => clearInterval(refreshTimer));

    return {
      lastUpdated, activeSection,
      // Oil indexes
      prices, symbols, spreadA, spreadB, spread, spreadLabel, SYMBOL_LABELS,
      spreadHistorySeries, spreadHistoryRange, spreadHistoryLoading, spreadHistoryError,
      showSpreadHistoryTable, filteredSpreadHistory, RANGE_OPTIONS,
      // Gas prices + crack spread
      gasSeries, dieselSeries, gasLoading, gasError, hasKey,
      rbobPrice, heatingOilPrice, wtiPrice, crackSpread, crackTier, crackLoading, crackError,
      historyGrade, historyRange, filteredHistory, historyLoading, historyError, showHistoryTable,
      latestByProduct, PRODUCT_LABELS, PRODUCT_ORDER, HISTORY_GRADES,
      formatUSD, formatPct, formatDate, changeClass,
    };
  },
  template: `
    <div>
      <div class="flex-between mb-16">
        <div class="section-header" style="margin-bottom:0">Oil &amp; Gas Markets</div>
        <div class="text-muted text-sm" v-if="lastUpdated">Updated {{ lastUpdated }}</div>
      </div>

      <div class="subtab-bar">
        <button class="subtab-btn" :class="{ active: activeSection === 'oil' }" @click="activeSection = 'oil'">Oil Price Indexes</button>
        <button class="subtab-btn" :class="{ active: activeSection === 'gas' }" @click="activeSection = 'gas'">Retail Gas Prices</button>
      </div>

      <template v-if="activeSection === 'oil'">
      <div class="price-grid mb-24">
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

      <!-- Oil Indexes Data Table -->
      <div class="card mb-24">
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

      <div class="notice text-sm">
        Oil prices/spreads sourced from Yahoo Finance (unofficial API), delayed 15–20 minutes.
      </div>
      </template>

      <template v-if="activeSection === 'gas'">
      <!-- 3-2-1 Crack Spread — wholesale futures, no EIA key required -->
      <div class="notice error mb-24" v-if="crackError">
        Failed to load crack spread: {{ crackError }}
      </div>
      <template v-else-if="crackLoading">
        <div class="crack-spread-card mb-24">
          <div class="skeleton" style="width:120px;height:12px;margin-bottom:8px"></div>
          <div class="skeleton" style="width:160px;height:32px"></div>
        </div>
      </template>
      <div class="crack-spread-card mb-24" v-else-if="crackSpread !== null">
        <div class="card-title">3-2-1 Crack Spread</div>
        <div class="crack-value-row">
          <span class="crack-indicator-dot" :class="'tier-' + crackTier.slug" :title="crackTier.label"></span>
          <div class="crack-value" :class="changeClass(crackSpread)">
            {{ formatUSD(crackSpread) }}<span class="text-muted" style="font-size:14px"> / bbl</span>
          </div>
          <span class="crack-tier-label" :class="'tier-' + crackTier.slug">{{ crackTier.label }}</span>
        </div>
        <div class="crack-formula">
          Formula: (2 × RBOB Gasoline + 1 × Heating Oil − 3 × WTI) ÷ 3 &nbsp;|&nbsp;
          RBOB: {{ formatUSD(rbobPrice) }}/gal &nbsp;·&nbsp;
          Heating Oil: {{ formatUSD(heatingOilPrice) }}/gal &nbsp;·&nbsp;
          WTI: {{ formatUSD(wtiPrice) }}/bbl
        </div>
      </div>

      <!-- No EIA key notice — only blocks the retail sections below -->
      <div class="notice warn" v-if="!hasKey">
        <strong>EIA API key not configured</strong> — the retail gasoline/diesel prices below need one.
        This is a fixed setting for this deployment, not something you can enter here: whoever is
        running this app needs to set the <code>EIA_API_KEY</code> environment variable (see the README).
        The crack spread above uses live futures and doesn't need this key.
      </div>

      <template v-if="hasKey">
        <div class="notice error" v-if="gasError">
          Failed to load EIA data: {{ gasError }}
        </div>

        <template v-if="gasLoading">
          <div class="card mb-24">
            <div class="skeleton" style="width:60%;height:14px;margin-bottom:8px"></div>
            <div class="skeleton" style="width:40%;height:12px"></div>
          </div>
        </template>

        <template v-else>
          <!-- Current Prices by Grade -->
          <div class="card mb-24">
            <div class="card-title">Current National Average Retail Prices</div>
            <table class="data-table">
              <thead>
                <tr>
                  <th>Grade</th>
                  <th class="num">Price (USD/gal)</th>
                  <th>As of Week</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="product in [...PRODUCT_ORDER, 'EPD2D']" :key="product">
                  <td>{{ PRODUCT_LABELS[product] }}</td>
                  <td class="num" style="font-weight:600">
                    {{ latestByProduct[product] ? formatUSD(Number(latestByProduct[product].value)) : '—' }}
                  </td>
                  <td class="text-muted">{{ latestByProduct[product]?.period ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- Historical Gas Price Chart -->
        <div class="card">
          <div class="flex-between mb-16" style="flex-wrap:wrap;gap:12px">
            <div class="card-title" style="margin-bottom:0">Historical Prices</div>
            <div class="chart-filters">
              <select v-model="historyGrade">
                <option v-for="g in HISTORY_GRADES" :key="g" :value="g">{{ PRODUCT_LABELS[g] }}</option>
              </select>
              <div class="range-btn-group">
                <button
                  v-for="r in RANGE_OPTIONS" :key="r.id"
                  class="range-btn" :class="{ active: historyRange === r.id }"
                  @click="historyRange = r.id"
                >{{ r.label }}</button>
              </div>
            </div>
          </div>

          <div class="notice error" v-if="historyError">Failed to load history: {{ historyError }}</div>
          <template v-else-if="historyLoading">
            <div class="skeleton" style="width:100%;height:260px"></div>
          </template>
          <template v-else-if="filteredHistory.length">
            <HistoryChart :data="filteredHistory" />
            <div style="margin-top:10px">
              <button @click="showHistoryTable = !showHistoryTable">
                {{ showHistoryTable ? 'Hide' : 'View' }} as table
              </button>
            </div>
            <table class="data-table" style="margin-top:10px" v-if="showHistoryTable">
              <thead>
                <tr>
                  <th>Week</th>
                  <th class="num">{{ PRODUCT_LABELS[historyGrade] }} (USD/gal)</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in [...filteredHistory].reverse()" :key="row.period">
                  <td>{{ row.period }}</td>
                  <td class="num">{{ formatUSD(Number(row.value)) }}</td>
                </tr>
              </tbody>
            </table>
          </template>
          <div class="notice text-sm" v-else>No data available for this range.</div>
        </div>
      </template>

      <div class="notice text-sm" style="margin-top:12px">
        Crack spread uses live RBOB Gasoline, Heating Oil, and WTI futures (Yahoo Finance). Retail gas/diesel
        prices sourced from the U.S. Energy Information Administration (EIA) Weekly Retail Gasoline and Diesel Prices.
      </div>
      </template>
    </div>
  `,
};
