const { ref, reactive, onMounted, onUnmounted, computed } = Vue;
import { fetchBatchQuotes, fetchChart } from '../services/yahooFinance.js';
import { formatUSD, formatPct, formatVolume, changeClass } from '../utils/formatters.js';

/**
 * Build a minimal inline SVG sparkline from an array of close prices.
 * Returns an SVG string (safe to use with v-html).
 */
function buildSparklineSVG(closes, width = 80, height = 30) {
  const vals = closes.filter(v => v != null);
  if (vals.length < 2) return '';
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const step = width / (vals.length - 1);
  const points = vals.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const lastVal = vals[vals.length - 1];
  const firstVal = vals[0];
  const color = lastVal >= firstVal ? 'var(--positive)' : 'var(--negative)';
  return `<svg class="sparkline" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

export default {
  name: 'Stocks',
  props: ['config'],
  setup(props) {
    const quotes = ref([]);
    const sparklines = reactive({});   // symbol → SVG string
    const loading = ref(true);
    const error = ref(null);
    const lastUpdated = ref(null);
    let refreshTimer = null;

    const tickers = computed(() => props.config.stocks?.tickers ?? []);

    async function fetchAll() {
      loading.value = quotes.value.length === 0;
      error.value = null;
      try {
        const results = await fetchBatchQuotes(tickers.value);
        quotes.value = results;
        lastUpdated.value = new Date().toLocaleTimeString();
        // Fetch sparklines in parallel (best-effort, don't block main data)
        results.forEach(async (q) => {
          try {
            const chart = await fetchChart(q.symbol, '1mo', '1d');
            sparklines[q.symbol] = buildSparklineSVG(chart.closes);
          } catch {
            sparklines[q.symbol] = '';
          }
        });
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

    return { quotes, sparklines, loading, error, lastUpdated, tickers, formatUSD, formatPct, formatVolume, changeClass };
  },
  template: `
    <div>
      <div class="flex-between mb-16">
        <div class="section-header" style="margin-bottom:0">Stock Watchlist</div>
        <div class="flex gap-8" style="align-items:center">
          <div class="text-muted text-sm" v-if="lastUpdated">Updated {{ lastUpdated }}</div>
        </div>
      </div>

      <div class="notice" v-if="tickers.length === 0">
        No tickers configured. Add tickers in the ⚙ Settings tab.
      </div>

      <div class="notice error" v-if="error">
        Failed to load quotes: {{ error }}
      </div>

      <template v-if="loading && quotes.length === 0">
        <div class="card">
          <div v-for="i in 5" :key="i" style="padding:10px 0;border-bottom:1px solid var(--border)">
            <div class="skeleton" style="width:60%;height:14px;margin-bottom:6px"></div>
            <div class="skeleton" style="width:30%;height:12px"></div>
          </div>
        </div>
      </template>

      <div class="card" v-else-if="quotes.length">
        <table class="data-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Company</th>
              <th class="num">Price</th>
              <th class="num">Change</th>
              <th class="num">% Change</th>
              <th class="num">Volume</th>
              <th class="num">30d</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="q in quotes" :key="q.symbol">
              <td style="font-weight:600">{{ q.symbol }}</td>
              <td class="text-muted">{{ q.shortName }}</td>
              <td class="num">{{ formatUSD(q.price) }}</td>
              <td class="num" :class="changeClass(q.change)">{{ formatUSD(q.change) }}</td>
              <td class="num" :class="changeClass(q.pctChange)">{{ formatPct(q.pctChange) }}</td>
              <td class="num text-muted">{{ formatVolume(q.volume) }}</td>
              <td class="num">
                <span v-if="sparklines[q.symbol]" v-html="sparklines[q.symbol]"></span>
                <span v-else class="text-muted text-sm">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="notice text-sm" style="margin-top:12px">
        Data sourced from Yahoo Finance (unofficial API). Prices may be delayed 15–20 minutes.
        Manage tickers in ⚙ Settings.
      </div>
    </div>
  `,
};
