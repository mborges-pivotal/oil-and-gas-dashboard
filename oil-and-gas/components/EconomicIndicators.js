const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
import { fetchSeriesHistory, fetchCPIYoYHistory } from '../services/fred.js';
import { fetchFeed, mergeFeeds } from '../services/rss.js';
import { formatPercentLevel, formatPct, formatDate, changeClass } from '../utils/formatters.js';
import { RANGE_OPTIONS, cutoffDateFor } from '../utils/dateRange.js';
import HistoryChart from './HistoryChart.js';
import DualLineChart from './DualLineChart.js';

const NEWS_STAGGER_MS = 600; // delay between feed requests to respect rate limits

// `fred` is the series ID to fetch, except 'CPI_YOY' which is a derived
// series (see fetchCPIYoYHistory) — FRED doesn't publish YoY inflation
// directly, only the raw CPI index.
const SERIES = [
  { id: 'CPI_YOY', label: 'Inflation (CPI YoY)', fred: 'CPIAUCSL', signed: false },
  { id: 'UNRATE', label: 'Unemployment Rate', fred: 'UNRATE', signed: false },
  { id: 'FEDFUNDS', label: 'Fed Funds Rate', fred: 'FEDFUNDS', signed: false },
  { id: 'DGS2', label: '2-Year Treasury', fred: 'DGS2', signed: false },
  { id: 'DGS10', label: '10-Year Treasury', fred: 'DGS10', signed: false },
  { id: 'DGS30', label: '30-Year Treasury', fred: 'DGS30', signed: false },
  { id: 'T10Y2Y', label: '10Y–2Y Yield Curve', fred: 'T10Y2Y', signed: true },
];

export default {
  name: 'EconomicIndicators',
  components: { HistoryChart, DualLineChart },
  props: ['config'],
  setup(props) {
    // id → { history: [{period, value}] (ascending), loading, error }
    const indicators = reactive(Object.fromEntries(
      SERIES.map(s => [s.id, { history: [], loading: true, error: null }])
    ));
    const lastUpdated = ref(null);
    let refreshTimer = null;

    const hasKey = computed(() => !!props.config.fredApiKey?.trim());

    const selectedSeries = ref('DGS10');
    const historyRange = ref('1Y');
    const showHistoryTable = ref(false);

    function formatterFor(id) {
      const series = SERIES.find(s => s.id === id);
      return series?.signed ? formatPct : formatPercentLevel;
    }

    const filteredHistory = computed(() => {
      const cutoff = cutoffDateFor(historyRange.value);
      return (indicators[selectedSeries.value]?.history ?? [])
        .filter(r => new Date(r.period) >= cutoff)
        .slice()
        .sort((a, b) => a.period.localeCompare(b.period));
    });

    // The yield-curve option overlays both legs (10Y vs 2Y) instead of just
    // the spread value — seeing them cross is the actual economic signal,
    // more legible than a single line dipping below zero. Derived from the
    // 10Y/2Y histories already fetched for their own cards, aligned by date
    // rather than assumed to line up index-for-index (both are FRED daily
    // Treasury series on the same business-day calendar, but align
    // explicitly anyway — same discipline as the Oil Prices spread chart).
    const isYieldCurve = computed(() => selectedSeries.value === 'T10Y2Y');

    const yieldCurveDual = computed(() => {
      const tenY = indicators.DGS10.history;
      const twoY = indicators.DGS2.history;
      const byDate = new Map(twoY.map(v => [v.period, v.value]));
      const merged = [];
      for (const row of tenY) {
        const b = byDate.get(row.period);
        if (b == null) continue;
        merged.push({ period: row.period, a: row.value, b });
      }
      const cutoff = cutoffDateFor(historyRange.value);
      return merged
        .filter(r => new Date(r.period) >= cutoff)
        .sort((a, b) => a.period.localeCompare(b.period));
    });

    const yieldCurveDualLoading = computed(() =>
      (indicators.DGS10.loading && !indicators.DGS10.history.length) ||
      (indicators.DGS2.loading && !indicators.DGS2.history.length)
    );
    const yieldCurveDualError = computed(() => indicators.DGS10.error || indicators.DGS2.error);

    async function fetchOne(series) {
      const entry = indicators[series.id];
      entry.loading = entry.history.length === 0;
      entry.error = null;
      try {
        entry.history = series.id === 'CPI_YOY'
          ? await fetchCPIYoYHistory(props.config.fredApiKey.trim())
          : await fetchSeriesHistory(series.fred, props.config.fredApiKey.trim());
      } catch (e) {
        entry.error = e.message;
      } finally {
        entry.loading = false;
      }
    }

    async function fetchAll() {
      if (!hasKey.value) return;
      await Promise.all(SERIES.map(fetchOne));
      lastUpdated.value = new Date().toLocaleTimeString();
    }

    // ── Related news ─────────────────────────────────────────────────────
    // Opt-in per feed (Settings → News RSS Feeds → "Econ Indicators"
    // checkbox) — most news feeds aren't about macro data, so this stays
    // empty/hidden unless the user tags at least one.
    const relatedFeeds = computed(() =>
      (props.config.news?.feeds ?? []).filter(f => f.enabled !== false && f.showInEconomicIndicators)
    );
    const newsDays = computed(() => props.config.news?.economicNewsDays ?? 7);
    const relatedNews = ref([]);
    const relatedNewsLoading = ref(true);
    const relatedNewsError = ref(null);

    async function fetchRelatedNews() {
      if (!relatedFeeds.value.length) {
        relatedNews.value = [];
        relatedNewsLoading.value = false;
        return;
      }
      relatedNewsLoading.value = relatedNews.value.length === 0;
      relatedNewsError.value = null;
      const proxy = props.config.news?.rssProxy ?? 'rss2json';
      const results = [];
      for (let i = 0; i < relatedFeeds.value.length; i++) {
        const feed = relatedFeeds.value[i];
        if (i > 0) await new Promise(r => setTimeout(r, NEWS_STAGGER_MS)); // stagger to respect proxy rate limits
        try {
          results.push(await fetchFeed(feed.url, feed.name, proxy));
        } catch (e) {
          relatedNewsError.value = e.message;
          results.push([]);
        }
      }
      const cutoffMs = Date.now() - newsDays.value * 24 * 60 * 60 * 1000;
      relatedNews.value = mergeFeeds(results).filter(a => a.pubDate && new Date(a.pubDate).getTime() >= cutoffMs);
      relatedNewsLoading.value = false;
    }

    function relativeTime(isoStr) {
      if (!isoStr) return '';
      const diff = Date.now() - new Date(isoStr).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      const days = Math.floor(hrs / 24);
      return `${days}d ago`;
    }

    // Some feed-provided image URLs 404 or block hotlinking — hide the
    // broken image instead of showing the browser's broken-image icon.
    function onImageError(e) {
      e.target.closest('a').style.display = 'none';
    }

    onMounted(() => {
      fetchAll();
      fetchRelatedNews();
      // Daily series (Treasury yields) update once a day, not intraday —
      // a long interval avoids burning API calls for data that isn't moving.
      refreshTimer = setInterval(fetchAll, 30 * 60 * 1000);
    });
    onUnmounted(() => clearInterval(refreshTimer));

    return {
      SERIES, indicators, hasKey, lastUpdated,
      selectedSeries, historyRange, showHistoryTable, filteredHistory,
      isYieldCurve, yieldCurveDual, yieldCurveDualLoading, yieldCurveDualError,
      relatedFeeds, newsDays, relatedNews, relatedNewsLoading, relatedNewsError, relativeTime, onImageError,
      formatterFor, RANGE_OPTIONS,
      formatPercentLevel, formatPct, formatDate, changeClass,
    };
  },
  template: `
    <div>
      <div class="flex-between mb-16">
        <div class="section-header" style="margin-bottom:0">Economic Indicators</div>
        <div class="text-muted text-sm" v-if="lastUpdated">Updated {{ lastUpdated }}</div>
      </div>

      <div class="notice warn" v-if="!hasKey">
        <strong>FRED API key not configured.</strong> This is a fixed setting for this deployment, not
        something you can enter here: whoever is running this app needs to set the
        <code>FRED_API_KEY</code> environment variable (see the README).
      </div>

      <template v-if="hasKey">
        <!-- Indicator Cards -->
        <div class="price-grid">
          <div class="price-card" v-for="s in SERIES" :key="s.id">
            <div class="label">{{ s.label }}</div>
            <template v-if="indicators[s.id].loading && !indicators[s.id].history.length">
              <div class="skeleton" style="width:80%;height:28px;margin-top:4px"></div>
              <div class="skeleton" style="width:50%;height:14px;margin-top:6px"></div>
            </template>
            <template v-else-if="indicators[s.id].error">
              <div class="text-muted text-sm">Unavailable</div>
            </template>
            <template v-else-if="indicators[s.id].history.length">
              <div class="price" :class="s.signed ? changeClass(indicators[s.id].history.at(-1).value) : ''">
                {{ formatterFor(s.id)(indicators[s.id].history.at(-1).value) }}
              </div>
              <div class="change text-muted">As of {{ formatDate(indicators[s.id].history.at(-1).period) }}</div>
            </template>
            <template v-else>
              <div class="text-muted text-sm">No data</div>
            </template>
          </div>
        </div>

        <!-- Related News -->
        <div class="card mb-24" v-if="relatedFeeds.length">
          <div class="card-title">Recent News (last {{ newsDays }} days)</div>
          <div class="notice error" v-if="relatedNewsError">Failed to load news: {{ relatedNewsError }}</div>
          <template v-else-if="relatedNewsLoading">
            <div class="news-grid">
              <div class="news-card" v-for="i in 3" :key="i">
                <div class="skeleton news-card-image"></div>
                <div class="news-card-body">
                  <div class="skeleton" style="width:40%;height:12px;margin-bottom:8px"></div>
                  <div class="skeleton" style="width:90%;height:14px;margin-bottom:4px"></div>
                  <div class="skeleton" style="width:70%;height:14px"></div>
                </div>
              </div>
            </div>
          </template>
          <div class="news-grid" v-else-if="relatedNews.length">
            <div class="news-card" v-for="(article, i) in relatedNews" :key="article.link || i">
              <a v-if="article.image" :href="article.link" target="_blank" rel="noopener">
                <img class="news-card-image" :src="article.image" alt="" loading="lazy" @error="onImageError" />
              </a>
              <div class="news-card-body">
                <div class="news-meta">
                  <span class="source-badge">{{ article.source }}</span>
                  <span class="news-date">{{ relativeTime(article.pubDate) }}</span>
                </div>
                <div class="news-title">
                  <a :href="article.link" target="_blank" rel="noopener">{{ article.title }}</a>
                </div>
                <div class="news-snippet" v-if="article.description">{{ article.description }}</div>
              </div>
            </div>
          </div>
          <div class="notice text-sm" v-else>
            No news from the last {{ newsDays }} days. Adjust the day count in ⚙ Settings → News RSS Feeds.
          </div>
        </div>

        <!-- Historical Chart -->
        <div class="card mb-24">
          <div class="flex-between mb-16" style="flex-wrap:wrap;gap:12px">
            <div class="card-title" style="margin-bottom:0">Historical Chart</div>
            <div class="chart-filters">
              <select v-model="selectedSeries">
                <option v-for="s in SERIES" :key="s.id" :value="s.id">{{ s.label }}</option>
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

          <!-- Yield curve: both legs overlaid, so the crossing itself is visible -->
          <template v-if="isYieldCurve">
            <div class="notice error" v-if="yieldCurveDualError">Failed to load yield curve: {{ yieldCurveDualError }}</div>
            <template v-else-if="yieldCurveDualLoading">
              <div class="skeleton" style="width:100%;height:260px"></div>
            </template>
            <template v-else-if="yieldCurveDual.length">
              <DualLineChart :data="yieldCurveDual" label-a="10-Year Treasury" label-b="2-Year Treasury" :format-value="formatPercentLevel" />
              <p class="text-muted text-sm" style="margin-top:10px">
                Shaded green where the 10-Year yield is above the 2-Year (normal); red where below
                (inverted) — a widely watched recession signal.
              </p>
              <div style="margin-top:4px">
                <button @click="showHistoryTable = !showHistoryTable">
                  {{ showHistoryTable ? 'Hide' : 'View' }} as table
                </button>
              </div>
              <table class="data-table" style="margin-top:10px" v-if="showHistoryTable">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th class="num">10-Year</th>
                    <th class="num">2-Year</th>
                    <th class="num">Spread</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in [...yieldCurveDual].reverse()" :key="row.period">
                    <td>{{ row.period }}</td>
                    <td class="num">{{ formatPercentLevel(row.a) }}</td>
                    <td class="num">{{ formatPercentLevel(row.b) }}</td>
                    <td class="num" :class="changeClass(row.a - row.b)">{{ formatPercentLevel(row.a - row.b) }}</td>
                  </tr>
                </tbody>
              </table>
            </template>
            <div class="notice text-sm" v-else>No data available for this range.</div>
          </template>

          <!-- All other series: single line -->
          <template v-else>
            <div class="notice error" v-if="indicators[selectedSeries].error">
              Failed to load {{ SERIES.find(s => s.id === selectedSeries).label }}: {{ indicators[selectedSeries].error }}
            </div>
            <template v-else-if="indicators[selectedSeries].loading && !indicators[selectedSeries].history.length">
              <div class="skeleton" style="width:100%;height:260px"></div>
            </template>
            <template v-else-if="filteredHistory.length">
              <HistoryChart :data="filteredHistory" :format-value="formatterFor(selectedSeries)" />
              <div style="margin-top:10px">
                <button @click="showHistoryTable = !showHistoryTable">
                  {{ showHistoryTable ? 'Hide' : 'View' }} as table
                </button>
              </div>
              <table class="data-table" style="margin-top:10px" v-if="showHistoryTable">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th class="num">{{ SERIES.find(s => s.id === selectedSeries).label }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in [...filteredHistory].reverse()" :key="row.period">
                    <td>{{ row.period }}</td>
                    <td class="num">{{ formatterFor(selectedSeries)(row.value) }}</td>
                  </tr>
                </tbody>
              </table>
            </template>
            <div class="notice text-sm" v-else>No data available for this range.</div>
          </template>
        </div>
      </template>

      <div class="notice text-sm" style="margin-top:12px" v-if="hasKey">
        Data sourced from FRED (Federal Reserve Bank of St. Louis). Inflation is the year-over-year %
        change in CPI (CPIAUCSL); the yield curve is the 10-Year minus 2-Year Treasury spread — negative
        means inverted, a widely watched recession signal.
      </div>
    </div>
  `,
};
