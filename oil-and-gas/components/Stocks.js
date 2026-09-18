const { ref, reactive, onMounted, onUnmounted, computed } = Vue;
import { fetchQuote, fetchChart } from '../services/yahooFinance.js';
import { resolveCIK, fetchFilings, extractFilings, buildFilingUrl, buildIndexUrl, getTranscriptLinks } from '../services/edgar.js';
import { formatUSD, formatNumber, formatPct, formatVolume, formatDate, changeClass } from '../utils/formatters.js';

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
    const tickers = computed(() => props.config.stocks?.tickers ?? []);

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
            .then(chart => { sparklines[sym] = buildSparklineSVG(chart.closes); })
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

    // ── SEC documents, merged in under each ticker (was a separate Documents ──
    // tab with its own configured company list; now pulled directly for
    // whatever's in the Stock Watchlist, so there's nothing extra to
    // configure). Loaded lazily — only when a row is first expanded — rather
    // than eagerly for the whole watchlist on every visit, since SEC EDGAR is
    // rate-limited and a longer watchlist would mean a lot of unseen fetches.
    const documents = reactive({}); // ticker → { open, loading, loaded, error, cik, filings, activeTab }

    function ensureDocs(ticker) {
      if (!documents[ticker]) {
        documents[ticker] = { open: false, loading: false, loaded: false, error: null, cik: null, filings: [], activeTab: '10-K' };
      }
    }

    async function loadDocs(ticker) {
      const entry = documents[ticker];
      if (entry.loaded || entry.loading) return;
      entry.loading = true;
      entry.error = null;
      try {
        const cik = await resolveCIK(ticker);
        if (!cik) throw new Error(`Ticker "${ticker}" not found in SEC EDGAR`);
        entry.cik = cik;
        const submissions = await fetchFilings(cik);
        entry.filings = extractFilings(submissions, ['10-K', '10-Q', '8-K', 'DEF 14A'], 10);
        entry.loaded = true;
      } catch (e) {
        entry.error = e.message;
      } finally {
        entry.loading = false;
      }
    }

    function toggleDocs(ticker) {
      ensureDocs(ticker);
      documents[ticker].open = !documents[ticker].open;
      if (documents[ticker].open) loadDocs(ticker);
    }

    function setDocsTab(ticker, tab) {
      if (documents[ticker]) documents[ticker].activeTab = tab;
    }

    function filingsForTab(ticker, tab) {
      return (documents[ticker]?.filings ?? []).filter(f => f.form === tab);
    }

    return {
      tickers, stockQuotes, sparklines, lastUpdated,
      indexSymbols, indexes, INDEX_LABELS,
      documents, toggleDocs, setDocsTab, filingsForTab, FORM_TABS,
      buildFilingUrl, buildIndexUrl, getTranscriptLinks,
      formatUSD, formatNumber, formatPct, formatVolume, formatDate, changeClass,
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

      <!-- Watchlist as accordions — expand a ticker to see its SEC filings -->
      <div class="accordion-item" v-for="sym in tickers" :key="sym">
        <div class="accordion-header stock-row-header" :class="{ open: documents[sym]?.open }" @click="toggleDocs(sym)">
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
                <span class="stock-row-num" :class="changeClass(stockQuotes[sym]?.change)">{{ formatUSD(stockQuotes[sym]?.change) }}</span>
                <span class="stock-row-num" :class="changeClass(stockQuotes[sym]?.pctChange)">{{ formatPct(stockQuotes[sym]?.pctChange) }}</span>
                <span class="stock-row-num text-muted">{{ formatVolume(stockQuotes[sym]?.volume) }}</span>
              </template>
              <span class="stock-row-sparkline" v-if="sparklines[sym]" v-html="sparklines[sym]"></span>
              <span class="stock-row-sparkline" v-else></span>
            </div>
          </div>
          <span class="chevron">▶</span>
        </div>

        <!-- SEC filings — same content that used to live on the standalone Documents tab -->
        <div class="accordion-body" v-if="documents[sym]?.open">
          <template v-if="documents[sym]?.loading">
            <div style="padding:16px">
              <div class="skeleton" style="width:60%;height:14px;margin-bottom:8px"></div>
              <div class="skeleton" style="width:40%;height:12px"></div>
            </div>
          </template>

          <div class="notice error" style="margin:12px" v-else-if="documents[sym]?.error">
            {{ documents[sym].error }}
          </div>

          <template v-else-if="documents[sym]?.loaded">
            <div class="filing-tabs">
              <button
                v-for="tab in FORM_TABS"
                :key="tab.id"
                class="filing-tab"
                :class="{ active: documents[sym]?.activeTab === tab.id }"
                @click.stop="setDocsTab(sym, tab.id)"
              >{{ tab.label }}</button>
            </div>

            <div style="padding:12px 16px" v-if="documents[sym]?.activeTab === 'transcript'">
              <p class="text-muted text-sm" style="margin-bottom:12px">
                No free API exists for earnings transcripts. Links below open external search pages.
              </p>
              <div v-for="link in getTranscriptLinks(sym)" :key="link.url" style="margin-bottom:8px">
                <a :href="link.url" target="_blank" rel="noopener">{{ link.label }}</a>
              </div>
            </div>

            <div v-else style="padding:4px 0">
              <div v-if="filingsForTab(sym, documents[sym]?.activeTab).length === 0"
                   class="text-muted text-sm" style="padding:16px">
                No {{ documents[sym]?.activeTab }} filings found in recent history.
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
                  <tr v-for="filing in filingsForTab(sym, documents[sym]?.activeTab)" :key="filing.accessionNumber">
                    <td style="font-weight:600">{{ filing.form }}</td>
                    <td>{{ filing.filingDate }}</td>
                    <td class="text-muted">{{ filing.reportDate || '—' }}</td>
                    <td>
                      <a
                        v-if="filing.primaryDocument"
                        :href="buildFilingUrl(documents[sym].cik, filing.accessionNumber, filing.primaryDocument)"
                        target="_blank" rel="noopener"
                      >{{ filing.primaryDocument }}</a>
                      <span v-else class="text-muted">—</span>
                    </td>
                    <td>
                      <a
                        :href="buildIndexUrl(documents[sym].cik, filing.accessionNumber)"
                        target="_blank" rel="noopener"
                        class="text-muted text-sm"
                      >View index</a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </div>
      </div>

      <div class="notice text-sm" style="margin-top:12px" v-if="tickers.length">
        Quotes/sparklines from Yahoo Finance (unofficial API), delayed 15–20 minutes. SEC filings from
        SEC EDGAR (data.sec.gov), no API key required, loaded when you expand a ticker. Manage tickers in ⚙ Settings.
      </div>
    </div>
  `,
};
