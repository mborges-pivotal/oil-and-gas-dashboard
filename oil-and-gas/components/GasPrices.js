const { ref, computed, onMounted, onUnmounted, watch } = Vue;
import { fetchGasPrices, fetchDieselPrices, fetchGasPriceHistory } from '../services/eia.js';
import { fetchQuote } from '../services/yahooFinance.js';
import { calcCrackSpread, classifyCrackSpread, DEFAULT_CRACK_SPREAD_THRESHOLDS } from '../utils/spread.js';
import { formatUSD, formatPct, formatDate, changeClass } from '../utils/formatters.js';
import { RANGE_OPTIONS, cutoffDateFor } from '../utils/dateRange.js';
import HistoryChart from './HistoryChart.js';

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
  name: 'GasPrices',
  components: { HistoryChart },
  props: ['config'],
  setup(props) {
    const gasSeries = ref([]);    // raw EIA rows
    const dieselSeries = ref([]); // raw EIA diesel rows
    const loading = ref(true);
    const error = ref(null);

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

    // Historical price chart state. Defaults to Regular — the grade
    // commonly cited as "the national average gas price" — but any grade
    // (including All Grades Avg) is one click away via the dropdown.
    const historyGrade = ref('EPMR');
    const historyRange = ref('1Y');
    const historySeries = ref([]); // raw EIA rows, desc by period, for historyGrade
    const historyLoading = ref(true);
    const historyError = ref(null);
    const showHistoryTable = ref(false);

    const lastUpdated = ref(null);
    let refreshTimer = null;

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

    async function fetchRetail() {
      if (!hasKey.value) return;
      loading.value = gasSeries.value.length === 0;
      error.value = null;
      try {
        const key = props.config.eiaApiKey.trim();
        const [gas, diesel] = await Promise.all([
          fetchGasPrices(key, 12),
          fetchDieselPrices(key, 4),
        ]);
        gasSeries.value = gas;
        dieselSeries.value = diesel;
      } catch (e) {
        error.value = e.message;
      } finally {
        loading.value = false;
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
    async function fetchHistory() {
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

    watch(historyGrade, fetchHistory);

    async function fetchAll() {
      await Promise.all([fetchRetail(), fetchCrackSpread()]);
      lastUpdated.value = new Date().toLocaleTimeString();
    }

    onMounted(() => {
      fetchAll();
      fetchHistory();
      const interval = Math.max(30, props.config.ui?.refreshIntervalSeconds ?? 60) * 1000;
      refreshTimer = setInterval(fetchAll, interval);
    });
    onUnmounted(() => clearInterval(refreshTimer));

    return {
      gasSeries, dieselSeries, loading, error, hasKey,
      rbobPrice, heatingOilPrice, wtiPrice, crackSpread, crackTier, crackLoading, crackError,
      historyGrade, historyRange, filteredHistory, historyLoading, historyError, showHistoryTable,
      lastUpdated,
      latestByProduct, PRODUCT_LABELS, PRODUCT_ORDER, HISTORY_GRADES, RANGE_OPTIONS,
      formatUSD, formatPct, formatDate, changeClass,
    };
  },
  template: `
    <div>
      <div class="flex-between mb-16">
        <div class="section-header" style="margin-bottom:0">US Retail Gas Prices + Crack Spread</div>
        <div class="text-muted text-sm" v-if="lastUpdated">Updated {{ lastUpdated }}</div>
      </div>

      <!-- Crack Spread Card — wholesale futures, no EIA key required -->
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
        <strong>EIA API key required</strong> for the retail gasoline/diesel prices below.
        Enter your free API key in the <strong>⚙ Settings</strong> tab to enable this.
        Get one at <a href="https://www.eia.gov/opendata/" target="_blank">eia.gov/opendata</a>.
        The crack spread above uses live futures and doesn't need this key.
      </div>

      <template v-if="hasKey">
        <div class="notice error" v-if="error">
          Failed to load EIA data: {{ error }}
        </div>

        <template v-if="loading">
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

        <!-- Historical Price Chart -->
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

      <div class="notice text-sm" style="margin-top:12px" v-if="crackSpread !== null || hasKey">
        Crack spread uses live RBOB Gasoline, Heating Oil, and WTI futures (Yahoo Finance).
        Retail prices sourced from U.S. Energy Information Administration (EIA) Weekly Retail Gasoline and Diesel Prices.
      </div>
    </div>
  `,
};
