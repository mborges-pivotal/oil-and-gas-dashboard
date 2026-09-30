const { ref, reactive, onMounted, onUnmounted, computed, nextTick } = Vue;
import { fetchQuote, fetchChart, fetchKeyStats, fetchTickerNews } from '../services/yahooFinance.js';
import { resolveCIK, fetchFilings, extractFilings, buildFilingUrl, buildIndexUrl, getTranscriptLinks } from '../services/edgar.js';
import { formatUSD, formatNumber, formatPct, formatPercentLevel, formatVolume, formatLargeUSD, formatDate, formatRelativeTime, changeClass } from '../utils/formatters.js';
import { safeArticleUrl, onArticleClick } from '../utils/articleViewer.js';
import { RANGE_OPTIONS, cutoffDateFor } from '../utils/dateRange.js';
import HistoryChart from './HistoryChart.js';

const INDEX_LABELS = {
  '^GSPC': 'S&P 500',
  '^DJI': 'Dow Jones',
  '^IXIC': 'Nasdaq Composite',
  '^RUT': 'Russell 2000',
  '^VIX': 'VIX (Volatility)',
};
// Matches config.json's marketIndexes.symbols — used as a fallback for
// anyone whose localStorage-persisted config predates this field (loadConfig
// only pulls in config.json's *new* top-level fields on a first-ever visit,
// not for a returning visitor who already has a saved config).
const DEFAULT_INDEX_SYMBOLS = Object.keys(INDEX_LABELS);

const FORM_TABS = [
  { id: '10-K',    label: '10-K Annual' },
  { id: '10-Q',    label: '10-Q Quarterly' },
  { id: '8-K',     label: '8-K Current' },
  { id: 'DEF 14A', label: 'Proxy' },
  { id: 'transcript', label: 'Transcripts' },
];

/**
 * Build a minimal inline SVG sparkline from an array of close prices, with
 * an optional dashed reference line at today's open — green when the latest
 * price is at/above it, red when below.
 * Returns an SVG string (safe to use with v-html).
 */
function buildSparklineSVG(closes, { open = null, price = null } = {}, width = 80, height = 30) {
  const vals = closes.filter(v => v != null);
  if (vals.length < 2) return '';
  const hasOpen = open != null && price != null;
  // Include the open in the scale so its line never falls outside the box.
  const min = Math.min(...vals, ...(hasOpen ? [open] : []));
  const max = Math.max(...vals, ...(hasOpen ? [open] : []));
  const range = max - min || 1;
  const step = width / (vals.length - 1);
  const yFor = v => height - ((v - min) / range) * (height - 4) - 2;
  const points = vals.map((v, i) => {
    const x = i * step;
    const y = yFor(v);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const lastVal = vals[vals.length - 1];
  const firstVal = vals[0];
  const color = lastVal >= firstVal ? 'var(--positive)' : 'var(--negative)';
  const openLine = hasOpen
    ? `<line x1="0" x2="${width}" y1="${yFor(open).toFixed(1)}" y2="${yFor(open).toFixed(1)}"
        stroke="${price >= open ? 'var(--positive)' : 'var(--negative)'}" stroke-width="1" stroke-dasharray="2 2" opacity="0.8"/>`
    : '';
  return `<svg class="sparkline" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${openLine}
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

// Base window fetched once per ticker; range buttons then filter this
// client-side (same pattern as the Oil & Gas Markets spread/gas history
// charts), so switching ranges doesn't re-hit the API.
const CHART_FETCH_RANGE = '5y';

export default {
  name: 'Stocks',
  components: { HistoryChart },
  props: ['config'],
  emits: ['reorder-tickers'],
  setup(props, { emit }) {
    const configTickers = computed(() => props.config.stocks?.tickers ?? []);

    // ── Watchlist reordering ────────────────────────────────────────────────
    // Drag a card by its ⠿ handle (mouse or touch, via Pointer Events —
    // native HTML5 drag-and-drop doesn't work on most touch browsers), or
    // focus the handle and use ↑/↓. While dragging, the list renders from
    // `dragOrder` and reorders live as the pointer passes a neighbor's
    // midpoint; on release the new order is emitted once, and the parent
    // saves it into config.stocks.tickers like any other setting.
    const dragOrder = ref(null);   // working order while a drag is active
    const tickers = computed(() => dragOrder.value ?? configTickers.value);
    const draggingTicker = ref(null);
    const watchlistEl = ref(null);
    let lastPointerY = 0;
    let autoScrollFrame = null;
    const AUTO_SCROLL_EDGE_PX = 60;
    const AUTO_SCROLL_MAX_SPEED = 14;

    function watchlistItems() {
      return [...watchlistEl.value.querySelectorAll(':scope > .watchlist-item')];
    }

    // Move the dragged ticker one slot at a time while the pointer is past
    // a neighbor's midpoint. Comparing only against neighbors (rather than
    // every card) keeps it stable when cards differ in height — e.g. when
    // one of them is expanded to show its chart.
    function repositionDragged() {
      const order = dragOrder.value;
      const items = watchlistItems();
      let i = order.indexOf(draggingTicker.value);
      let moved = false;
      while (i > 0) {
        const r = items[i - 1].getBoundingClientRect();
        if (lastPointerY >= r.top + r.height / 2) break;
        [order[i - 1], order[i]] = [order[i], order[i - 1]];
        [items[i - 1], items[i]] = [items[i], items[i - 1]];
        i--; moved = true;
      }
      while (!moved && i < order.length - 1) {
        const r = items[i + 1].getBoundingClientRect();
        if (lastPointerY <= r.top + r.height / 2) break;
        [order[i + 1], order[i]] = [order[i], order[i + 1]];
        [items[i + 1], items[i]] = [items[i], items[i + 1]];
        i++;
      }
    }

    // Pointer capture stops a touch drag from scrolling the page, so scroll
    // it ourselves when the pointer nears the top/bottom of the viewport.
    function autoScrollStep() {
      if (!draggingTicker.value) return;
      const y = lastPointerY;
      let speed = 0;
      if (y < AUTO_SCROLL_EDGE_PX) speed = -AUTO_SCROLL_MAX_SPEED * (1 - y / AUTO_SCROLL_EDGE_PX);
      else if (y > window.innerHeight - AUTO_SCROLL_EDGE_PX) speed = AUTO_SCROLL_MAX_SPEED * (1 - (window.innerHeight - y) / AUTO_SCROLL_EDGE_PX);
      if (speed) {
        window.scrollBy(0, speed);
        repositionDragged();
      }
      autoScrollFrame = requestAnimationFrame(autoScrollStep);
    }

    // Move/up are tracked on window rather than via setPointerCapture on
    // the handle: reordering can make Vue move the dragged card's DOM node,
    // and moving a node silently drops its pointer capture — the drop would
    // never arrive and the drag would get stuck.
    let activePointerId = null;
    // Releasing a drag fires a click on the card header (the press began on
    // the handle inside it), which would toggle that card open — swallow
    // the one click that immediately follows a drop.
    let suppressHeaderClick = false;

    function onHandlePointerDown(e, sym) {
      if (e.button !== 0 || draggingTicker.value || configTickers.value.length < 2) return;
      e.preventDefault(); // no text selection / focus-scroll while dragging
      activePointerId = e.pointerId;
      lastPointerY = e.clientY;
      dragOrder.value = [...configTickers.value];
      draggingTicker.value = sym;
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
      window.addEventListener('blur', endDrag);
      autoScrollFrame = requestAnimationFrame(autoScrollStep);
    }

    function onDragMove(e) {
      if (e.pointerId !== activePointerId) return;
      lastPointerY = e.clientY;
      repositionDragged();
    }

    function stopListening() {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('blur', endDrag);
      cancelAnimationFrame(autoScrollFrame);
    }

    // Drop — also on pointercancel and window blur (e.g. alt-tab mid-drag),
    // which keep whatever order was reached rather than leave a drag open.
    function endDrag(e) {
      if (e?.pointerId !== undefined && e.pointerId !== activePointerId) return;
      if (!draggingTicker.value) return;
      stopListening();
      suppressHeaderClick = true;
      setTimeout(() => { suppressHeaderClick = false; }, 0); // click, if any, fires before this
      const order = dragOrder.value;
      const changed = order.some((t, i) => t !== configTickers.value[i]);
      draggingTicker.value = null;
      // Parent updates config synchronously on emit, so there's no frame
      // where the list snaps back to the old order before it's saved.
      if (changed) emit('reorder-tickers', [...order]);
      dragOrder.value = null;
    }

    async function onHandleKeydown(e, sym) {
      const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      if (!delta) return;
      e.preventDefault();
      const order = [...configTickers.value];
      const from = order.indexOf(sym);
      const to = from + delta;
      if (to < 0 || to >= order.length) return;
      [order[from], order[to]] = [order[to], order[from]];
      emit('reorder-tickers', order);
      // Moving a DOM node can drop its focus — put it back on the handle.
      await nextTick();
      watchlistEl.value?.querySelector(`[data-ticker="${CSS.escape(sym)}"] .drag-handle`)?.focus();
    }

    onUnmounted(stopListening);

    // ── Quotes (ticker → { price, change, pctChange, volume, shortName, loading, error }) ──
    const stockQuotes = reactive({});
    const sparklines = reactive({});   // ticker → SVG string
    const lastUpdated = ref(null);
    let refreshTimer = null;

    async function fetchStockQuotes() {
      await Promise.all(tickers.value.map(async (sym) => {
        if (!stockQuotes[sym]) stockQuotes[sym] = { price: null, change: null, pctChange: null, volume: null, shortName: '', loading: true, error: null };
        else stockQuotes[sym].loading = true;
        try {
          const q = await fetchQuote(sym);
          stockQuotes[sym] = { ...q, loading: false, error: null };
          // Sparkline is best-effort — don't let a slow/failed chart block the quote
          fetchChart(sym, '1mo', '1d')
            .then(chart => { sparklines[sym] = buildSparklineSVG(chart.closes, q); })
            .catch(() => { sparklines[sym] = ''; });
        } catch (e) {
          stockQuotes[sym] = { price: null, change: null, pctChange: null, volume: null, shortName: '', loading: false, error: e.message };
        }
      }));
      lastUpdated.value = new Date().toLocaleTimeString();
    }

    // ── Major market indexes — symbol → { price, change, pctChange, loading, error } ──
    const indexSymbols = computed(() => props.config.marketIndexes?.symbols ?? DEFAULT_INDEX_SYMBOLS);
    const indexes = reactive({});

    async function fetchIndexes() {
      await Promise.all(indexSymbols.value.map(async (sym) => {
        if (!indexes[sym]) indexes[sym] = { price: null, change: null, pctChange: null, loading: true, error: null };
        else indexes[sym].loading = true;
        try {
          const q = await fetchQuote(sym);
          indexes[sym] = { ...q, loading: false, error: null };
        } catch (e) {
          indexes[sym] = { price: null, change: null, pctChange: null, loading: false, error: e.message };
        }
      }));
    }

    async function refreshAll() {
      await Promise.all([fetchStockQuotes(), fetchIndexes()]);
    }

    onMounted(() => {
      refreshAll();
      const interval = Math.max(30, props.config.ui?.refreshIntervalSeconds ?? 60) * 1000;
      refreshTimer = setInterval(refreshAll, interval);
    });
    onUnmounted(() => clearInterval(refreshTimer));

    // ── Per-ticker detail panel: two tabs, "Historical Chart" and ──
    // "Documents" (SEC filings — was a separate Documents tab with its own
    // configured company list; now pulled directly for whatever's in the
    // Stock Watchlist, so there's nothing extra to configure). Both tabs
    // load lazily — only when a row is first expanded, or when that tab is
    // first switched to — rather than eagerly for the whole watchlist on
    // every visit, since SEC EDGAR is rate-limited and Yahoo chart history
    // is one more request per ticker either way.
    const details = reactive({}); // ticker → { open, tab: 'chart'|'documents', chart: {...}, docs: {...} }

    function ensureDetail(ticker) {
      if (!details[ticker]) {
        details[ticker] = {
          open: false,
          tab: 'chart',
          chart: { loading: false, loaded: false, error: null, series: [], range: '1Y' },
          stats: { loading: false, loaded: false, data: null },
          news: { loading: false, loaded: false, error: null, items: [] },
          docs: { loading: false, loaded: false, error: null, cik: null, filings: [], activeTab: '10-K' },
        };
      }
    }

    async function loadChart(ticker) {
      const d = details[ticker].chart;
      if (d.loaded || d.loading) return;
      d.loading = true;
      d.error = null;
      try {
        const chart = await fetchChart(ticker, CHART_FETCH_RANGE, '1d');
        const series = [];
        chart.timestamps.forEach((ts, i) => {
          const close = chart.closes[i];
          if (close == null) return;
          series.push({ period: new Date(ts * 1000).toISOString().slice(0, 10), value: close });
        });
        d.series = series;
        d.loaded = true;
      } catch (e) {
        d.error = e.message;
      } finally {
        d.loading = false;
      }
    }

    // Key statistics under the chart. Best-effort: fetchKeyStats never
    // throws per-field, so a failure here just leaves those values as '—'.
    async function loadStats(ticker) {
      const d = details[ticker].stats;
      if (d.loaded || d.loading) return;
      d.loading = true;
      try {
        d.data = await fetchKeyStats(ticker);
        d.loaded = true;
      } catch {
        d.data = null;
      } finally {
        d.loading = false;
      }
    }

    // Day values come from the live quote (refreshed with the watchlist);
    // P/E, market cap and yield are recomputed against the live price.
    function keyStats(ticker) {
      const q = stockQuotes[ticker] ?? {};
      const s = details[ticker]?.stats.data ?? {};
      const price = q.price;
      const pe = price != null && s.eps > 0 ? price / s.eps : null;
      const marketCap = price != null && s.sharesOutstanding ? price * s.sharesOutstanding : null;
      const divYield = price && s.dividendsTTM != null ? (s.dividendsTTM / price) * 100 : null;
      return [
        { label: 'Open', value: formatUSD(q.open) },
        { label: 'High', value: formatUSD(q.dayHigh) },
        { label: 'Low', value: formatUSD(q.dayLow) },
        { label: 'Vol', value: formatVolume(q.volume) },
        { label: 'Avg Vol (3M)', fromStats: true, value: formatVolume(s.avgVolume) },
        { label: 'Mkt Cap', fromStats: true, value: formatLargeUSD(marketCap) },
        { label: 'P/E (TTM)', fromStats: true, value: formatNumber(pe) },
        { label: 'EPS (TTM)', fromStats: true, value: formatUSD(s.eps) },
        { label: 'Div Yield (TTM)', fromStats: true, value: formatPercentLevel(divYield) },
        { label: 'Beta (5Y)', fromStats: true, value: formatNumber(s.beta) },
        { label: '52W High', value: formatUSD(q.fiftyTwoWeekHigh) },
        { label: '52W Low', value: formatUSD(q.fiftyTwoWeekLow) },
      ];
    }

    async function loadNews(ticker) {
      const d = details[ticker].news;
      if (d.loaded || d.loading) return;
      d.loading = true;
      d.error = null;
      try {
        d.items = await fetchTickerNews(ticker);
        d.loaded = true;
      } catch (e) {
        d.error = e.message;
      } finally {
        d.loading = false;
      }
    }

    // Some thumbnail URLs 404 or block hotlinking — hide the broken image.
    function onNewsImageError(e) {
      e.target.style.display = 'none';
    }

    async function loadDocs(ticker) {
      const d = details[ticker].docs;
      if (d.loaded || d.loading) return;
      d.loading = true;
      d.error = null;
      try {
        const cik = await resolveCIK(ticker);
        if (!cik) throw new Error(`Ticker "${ticker}" not found in SEC EDGAR`);
        d.cik = cik;
        const submissions = await fetchFilings(cik);
        d.filings = extractFilings(submissions, ['10-K', '10-Q', '8-K', 'DEF 14A'], 10);
        d.loaded = true;
      } catch (e) {
        d.error = e.message;
      } finally {
        d.loading = false;
      }
    }

    function loadActiveTab(ticker) {
      if (details[ticker].tab === 'chart') {
        loadChart(ticker);
        loadStats(ticker);
      } else if (details[ticker].tab === 'news') loadNews(ticker);
      else loadDocs(ticker);
    }

    function toggleDetail(ticker) {
      if (suppressHeaderClick) return;
      ensureDetail(ticker);
      details[ticker].open = !details[ticker].open;
      if (details[ticker].open) loadActiveTab(ticker);
    }

    function setDetailTab(ticker, tab) {
      if (!details[ticker] || details[ticker].tab === tab) return;
      details[ticker].tab = tab;
      loadActiveTab(ticker);
    }

    function setDocsTab(ticker, tab) {
      if (details[ticker]) details[ticker].docs.activeTab = tab;
    }

    function filingsForTab(ticker, tab) {
      return (details[ticker]?.docs.filings ?? []).filter(f => f.form === tab);
    }

    // Chart series is fetched ascending already, but sort defensively —
    // same belt-and-suspenders as the Oil & Gas Markets spread history,
    // since a future change to the fetch order shouldn't silently corrupt
    // the chart's left-to-right ordering.
    function filteredChartData(ticker) {
      const d = details[ticker]?.chart;
      if (!d) return [];
      const cutoff = cutoffDateFor(d.range);
      return d.series
        .filter(r => new Date(r.period) >= cutoff)
        .slice()
        .sort((a, b) => a.period.localeCompare(b.period));
    }

    return {
      tickers, stockQuotes, sparklines, lastUpdated,
      watchlistEl, draggingTicker,
      onHandlePointerDown, onHandleKeydown,
      indexSymbols, indexes, INDEX_LABELS,
      details, toggleDetail, setDetailTab, setDocsTab, filingsForTab, filteredChartData, keyStats, onNewsImageError,
      FORM_TABS, RANGE_OPTIONS,
      buildFilingUrl, buildIndexUrl, getTranscriptLinks,
      formatUSD, formatNumber, formatPct, formatVolume, formatDate, formatRelativeTime, changeClass,
      safeArticleUrl, onArticleClick,
    };
  },
  template: `
    <div>
      <div class="flex-between mb-16">
        <div class="section-header" style="margin-bottom:0">Stocks</div>
        <div class="flex gap-8" style="align-items:center">
          <div class="text-muted text-sm" v-if="lastUpdated">Updated {{ lastUpdated }}</div>
        </div>
      </div>

      <!-- Major Market Indexes -->
      <div class="card-title" style="margin-bottom:10px">Major Market Indexes</div>
      <div class="price-grid mb-24">
        <div class="price-card" v-for="sym in indexSymbols" :key="sym">
          <div class="label">{{ INDEX_LABELS[sym] ?? sym }}</div>
          <template v-if="indexes[sym]?.loading && indexes[sym]?.price == null">
            <div class="skeleton" style="width:80%;height:28px;margin-top:4px"></div>
            <div class="skeleton" style="width:50%;height:14px;margin-top:6px"></div>
          </template>
          <template v-else-if="indexes[sym]?.error">
            <div class="text-muted text-sm">Unavailable</div>
          </template>
          <template v-else>
            <div class="price">{{ formatNumber(indexes[sym]?.price) }}</div>
            <div class="change" :class="changeClass(indexes[sym]?.change)">
              {{ formatNumber(indexes[sym]?.change, { signed: true }) }} ({{ formatPct(indexes[sym]?.pctChange) }})
            </div>
          </template>
        </div>
      </div>

      <div class="card-title" style="margin-bottom:10px">Stock Watchlist</div>

      <div class="notice" v-if="tickers.length === 0">
        No tickers configured. Add tickers in the ⚙ Settings tab.
      </div>

      <!-- Watchlist as accordions — expand a ticker to see its SEC filings; -->
      <!-- drag a card by its handle to reorder (saved to settings). -->
      <div ref="watchlistEl" class="watchlist" :class="{ 'is-dragging': draggingTicker }">
      <div class="accordion-item watchlist-item" v-for="sym in tickers" :key="sym" :data-ticker="sym"
           :class="{ dragging: draggingTicker === sym }">
        <div class="accordion-header stock-row-header" :class="{ open: details[sym]?.open }" @click="toggleDetail(sym)">
          <button
            v-if="tickers.length > 1"
            type="button"
            class="drag-handle"
            :aria-label="'Reorder ' + sym + ' — drag, or use the up/down arrow keys'"
            title="Drag to reorder (or focus and press ↑/↓)"
            @click.stop
            @pointerdown="onHandlePointerDown($event, sym)"
            @keydown="onHandleKeydown($event, sym)"
          >⠿</button>
          <div class="stock-row-main">
            <div class="stock-row-id">
              <span class="stock-row-ticker">{{ sym }}</span>
              <span class="text-muted text-sm">{{ stockQuotes[sym]?.shortName }}</span>
            </div>
            <div class="stock-row-metrics">
              <template v-if="stockQuotes[sym]?.loading && stockQuotes[sym]?.price == null">
                <span class="skeleton" style="width:100%;height:14px;grid-column:span 4"></span>
              </template>
              <template v-else-if="stockQuotes[sym]?.error">
                <span class="text-muted text-sm" style="grid-column:span 4">Unavailable</span>
              </template>
              <template v-else>
                <span class="stock-row-num">{{ formatUSD(stockQuotes[sym]?.price) }}</span>
                <span class="stock-row-num">
                  <span class="stock-row-label">Chg</span>
                  <span :class="changeClass(stockQuotes[sym]?.change)">{{ formatUSD(stockQuotes[sym]?.change) }}</span>
                </span>
                <span class="stock-row-num">
                  <span class="stock-row-label">Chg %</span>
                  <span :class="changeClass(stockQuotes[sym]?.pctChange)">{{ formatPct(stockQuotes[sym]?.pctChange) }}</span>
                </span>
                <span class="stock-row-num">
                  <span class="stock-row-label">Vol</span>
                  <span class="text-muted">{{ formatVolume(stockQuotes[sym]?.volume) }}</span>
                </span>
              </template>
              <span class="stock-row-sparkline" v-if="sparklines[sym]" v-html="sparklines[sym]"
                    :title="stockQuotes[sym]?.open != null ? 'Dashed line: open at ' + formatUSD(stockQuotes[sym].open) : null"></span>
              <span class="stock-row-sparkline" v-else></span>
            </div>
          </div>
          <span class="chevron">▶</span>
        </div>

        <!-- Historical Chart + Documents (SEC filings) — same content that -->
        <!-- used to live on the standalone Documents tab, now nested here. -->
        <div class="accordion-body" v-if="details[sym]?.open">
          <div class="filing-tabs">
            <button class="filing-tab" :class="{ active: details[sym]?.tab === 'chart' }" @click.stop="setDetailTab(sym, 'chart')">Historical Chart</button>
            <button class="filing-tab" :class="{ active: details[sym]?.tab === 'news' }" @click.stop="setDetailTab(sym, 'news')">News</button>
            <button class="filing-tab" :class="{ active: details[sym]?.tab === 'documents' }" @click.stop="setDetailTab(sym, 'documents')">Documents</button>
          </div>

          <!-- Historical Chart -->
          <template v-if="details[sym]?.tab === 'chart'">
            <div class="chart-filters" style="padding:12px 16px 0">
              <div class="range-btn-group">
                <button
                  v-for="r in RANGE_OPTIONS" :key="r.id"
                  class="range-btn" :class="{ active: details[sym]?.chart.range === r.id }"
                  @click.stop="details[sym].chart.range = r.id"
                >{{ r.label }}</button>
              </div>
            </div>

            <div style="padding:12px 16px" v-if="details[sym]?.chart.loading">
              <div class="skeleton" style="width:100%;height:220px"></div>
            </div>
            <div class="notice error" style="margin:12px" v-else-if="details[sym]?.chart.error">
              {{ details[sym].chart.error }}
            </div>
            <div style="padding:12px 16px" v-else-if="filteredChartData(sym).length">
              <HistoryChart :data="filteredChartData(sym)" />
            </div>
            <div class="text-muted text-sm" style="padding:16px" v-else>
              No price history available for this range.
            </div>

            <!-- Key statistics -->
            <div class="key-stats">
              <div class="key-stat" v-for="stat in keyStats(sym)" :key="stat.label">
                <span class="key-stat-label">{{ stat.label }}</span>
                <span class="skeleton key-stat-skeleton" v-if="stat.fromStats && details[sym]?.stats.loading"></span>
                <span class="key-stat-value" v-else>{{ stat.value }}</span>
              </div>
            </div>
          </template>

          <!-- News (Yahoo Finance, tagged to this ticker) -->
          <template v-else-if="details[sym]?.tab === 'news'">
            <div style="padding:12px 16px" v-if="details[sym]?.news.loading">
              <div class="stock-news-item" v-for="i in 4" :key="i">
                <div class="skeleton stock-news-thumb"></div>
                <div style="flex:1">
                  <div class="skeleton" style="width:85%;height:14px;margin-bottom:6px"></div>
                  <div class="skeleton" style="width:35%;height:11px"></div>
                </div>
              </div>
            </div>
            <div class="notice error" style="margin:12px" v-else-if="details[sym]?.news.error">
              {{ details[sym].news.error }}
            </div>
            <div class="text-muted text-sm" style="padding:16px" v-else-if="!details[sym]?.news.items.length">
              No recent news for {{ sym }}.
            </div>
            <div class="stock-news" v-else>
              <div class="stock-news-item" v-for="article in details[sym].news.items" :key="article.link">
                <img v-if="article.image" class="stock-news-thumb" :src="article.image" alt="" loading="lazy" @error="onNewsImageError" />
                <div class="stock-news-text">
                  <a class="stock-news-title" :href="safeArticleUrl(article.link)" target="_blank" rel="noopener"
                     @click.stop="onArticleClick($event, article, config)">{{ article.title }}</a>
                  <div class="text-muted text-sm">{{ article.source }} · {{ formatRelativeTime(article.pubDate) }}</div>
                </div>
              </div>
            </div>
          </template>

          <!-- Documents -->
          <template v-else>
            <template v-if="details[sym]?.docs.loading">
              <div style="padding:16px">
                <div class="skeleton" style="width:60%;height:14px;margin-bottom:8px"></div>
                <div class="skeleton" style="width:40%;height:12px"></div>
              </div>
            </template>

            <div class="notice error" style="margin:12px" v-else-if="details[sym]?.docs.error">
              {{ details[sym].docs.error }}
            </div>

            <template v-else-if="details[sym]?.docs.loaded">
              <div class="filing-tabs nested">
                <button
                  v-for="tab in FORM_TABS"
                  :key="tab.id"
                  class="filing-tab"
                  :class="{ active: details[sym]?.docs.activeTab === tab.id }"
                  @click.stop="setDocsTab(sym, tab.id)"
                >{{ tab.label }}</button>
              </div>

              <div style="padding:12px 16px" v-if="details[sym]?.docs.activeTab === 'transcript'">
                <p class="text-muted text-sm" style="margin-bottom:12px">
                  No free API exists for earnings transcripts. Links below open external search pages.
                </p>
                <div v-for="link in getTranscriptLinks(sym)" :key="link.url" style="margin-bottom:8px">
                  <a :href="link.url" target="_blank" rel="noopener">{{ link.label }}</a>
                </div>
              </div>

              <div v-else style="padding:4px 0">
                <div v-if="filingsForTab(sym, details[sym]?.docs.activeTab).length === 0"
                     class="text-muted text-sm" style="padding:16px">
                  No {{ details[sym]?.docs.activeTab }} filings found in recent history.
                </div>
                <table class="data-table" v-else>
                  <thead>
                    <tr>
                      <th>Form</th>
                      <th>Filed</th>
                      <th>Report Date</th>
                      <th>Document</th>
                      <th>Index</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="filing in filingsForTab(sym, details[sym]?.docs.activeTab)" :key="filing.accessionNumber">
                      <td style="font-weight:600">{{ filing.form }}</td>
                      <td>{{ filing.filingDate }}</td>
                      <td class="text-muted">{{ filing.reportDate || '—' }}</td>
                      <td>
                        <a
                          v-if="filing.primaryDocument"
                          :href="buildFilingUrl(details[sym].docs.cik, filing.accessionNumber, filing.primaryDocument)"
                          target="_blank" rel="noopener"
                        >{{ filing.primaryDocument }}</a>
                        <span v-else class="text-muted">—</span>
                      </td>
                      <td>
                        <a
                          :href="buildIndexUrl(details[sym].docs.cik, filing.accessionNumber)"
                          target="_blank" rel="noopener"
                          class="text-muted text-sm"
                        >View index</a>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
          </template>
        </div>
      </div>

      </div>

      <div class="notice text-sm" style="margin-top:12px" v-if="tickers.length">
        Quotes/sparklines and historical chart prices from Yahoo Finance (unofficial API), delayed 15–20 minutes.
        Ticker news from Yahoo Finance. SEC filings from SEC EDGAR (data.sec.gov), no API key required. Each tab loads the first time you open it. Drag a card by its ⠿ handle to reorder; manage tickers in ⚙ Settings.
      </div>
    </div>
  `,
};
