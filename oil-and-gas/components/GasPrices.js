const { ref, computed, onMounted, onUnmounted } = Vue;
import { fetchGasPrices, fetchDieselPrices } from '../services/eia.js';
import { fetchQuote } from '../services/yahooFinance.js';
import { calcCrackSpread } from '../utils/spread.js';
import { formatUSD, formatPct, formatDate, changeClass } from '../utils/formatters.js';

const PRODUCT_LABELS = {
  EPMR: 'Regular',
  EPMM: 'Midgrade',
  EPMP: 'Premium',
  EPM0: 'All Grades Avg',
  EPD2D: 'Diesel (ULSD)',
};

// Product display order
const PRODUCT_ORDER = ['EPMR', 'EPMM', 'EPMP', 'EPM0'];

export default {
  name: 'GasPrices',
  props: ['config'],
  setup(props) {
    const gasSeries = ref([]);    // raw EIA rows
    const dieselSeries = ref([]); // raw EIA diesel rows
    const wtiPrice = ref(null);
    const crackSpread = ref(null);
    const loading = ref(true);
    const error = ref(null);
    const lastUpdated = ref(null);
    let refreshTimer = null;

    const hasKey = computed(() => !!props.config.eiaApiKey?.trim());

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

    // Weekly history for Regular grade (for a simple price history table)
    const regularHistory = computed(() =>
      gasSeries.value
        .filter(r => r.product === 'EPMR')
        .slice(0, 8)
    );

    async function fetchAll() {
      if (!hasKey.value) return;
      loading.value = gasSeries.value.length === 0;
      error.value = null;
      try {
        const key = props.config.eiaApiKey.trim();
        const [gas, diesel, wti] = await Promise.all([
          fetchGasPrices(key, 12),
          fetchDieselPrices(key, 4),
          fetchQuote('CL=F'),
        ]);
        gasSeries.value = gas;
        dieselSeries.value = diesel;
        wtiPrice.value = wti.price;

        // Compute 3-2-1 crack spread using latest regular and diesel prices
        const latestGas = gas.find(r => r.product === 'EPMR');
        const latestDiesel = diesel[0];
        if (latestGas && latestDiesel && wti.price) {
          crackSpread.value = calcCrackSpread(
            Number(latestGas.value),
            Number(latestDiesel.value),
            wti.price
          );
        }
        lastUpdated.value = new Date().toLocaleTimeString();
      } catch (e) {
        error.value = e.message;
      } finally {
        loading.value = false;
      }
    }

    onMounted(() => {
      fetchAll();
      const interval = Math.max(30, props.config.ui?.refreshIntervalSeconds ?? 60) * 1000;
      refreshTimer = setInterval(fetchAll, interval);
    });
    onUnmounted(() => clearInterval(refreshTimer));

    return {
      gasSeries, dieselSeries, wtiPrice, crackSpread,
      loading, error, lastUpdated, hasKey,
      latestByProduct, regularHistory, PRODUCT_LABELS, PRODUCT_ORDER,
      formatUSD, formatPct, formatDate, changeClass,
    };
  },
  template: `
    <div>
      <div class="flex-between mb-16">
        <div class="section-header" style="margin-bottom:0">US Retail Gas Prices + Crack Spread</div>
        <div class="text-muted text-sm" v-if="lastUpdated">Updated {{ lastUpdated }}</div>
      </div>

      <!-- No EIA key notice -->
      <div class="notice warn" v-if="!hasKey">
        <strong>EIA API key required.</strong>
        Gas price data comes from the EIA Open Data API.
        Enter your free API key in the <strong>⚙ Settings</strong> tab to enable this feature.
        Get one at <a href="https://www.eia.gov/opendata/" target="_blank">eia.gov/opendata</a>.
      </div>

      <template v-if="hasKey">
        <!-- Error -->
        <div class="notice error" v-if="error">
          Failed to load EIA data: {{ error }}
        </div>

        <!-- Loading skeleton -->
        <template v-if="loading">
          <div class="crack-spread-card mb-24">
            <div class="skeleton" style="width:120px;height:12px;margin-bottom:8px"></div>
            <div class="skeleton" style="width:160px;height:32px"></div>
          </div>
        </template>

        <!-- Crack Spread Card -->
        <div class="crack-spread-card mb-24" v-else-if="crackSpread !== null">
          <div class="card-title">3-2-1 Crack Spread (WTI)</div>
          <div class="crack-value" :class="changeClass(crackSpread)">
            {{ formatUSD(crackSpread) }}<span class="text-muted" style="font-size:14px"> / bbl</span>
          </div>
          <div class="crack-formula">
            Formula: (2 × Gasoline + 1 × Diesel − 3 × WTI) ÷ 3 &nbsp;|&nbsp;
            WTI: {{ formatUSD(wtiPrice) }}/bbl
          </div>
        </div>

        <!-- Current Prices by Grade -->
        <div class="card mb-24" v-if="!loading">
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

        <!-- Regular Grade History -->
        <div class="card" v-if="regularHistory.length">
          <div class="card-title">Regular Grade — Weekly History (Last 8 Weeks)</div>
          <table class="data-table">
            <thead>
              <tr>
                <th>Week</th>
                <th class="num">Regular (USD/gal)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in regularHistory" :key="row.period">
                <td>{{ row.period }}</td>
                <td class="num">{{ formatUSD(Number(row.value)) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="notice text-sm" style="margin-top:12px">
          Source: U.S. Energy Information Administration (EIA) Weekly Retail Gasoline and Diesel Prices.
          Crack spread uses live WTI futures (CL=F) from Yahoo Finance.
        </div>
      </template>
    </div>
  `,
};
