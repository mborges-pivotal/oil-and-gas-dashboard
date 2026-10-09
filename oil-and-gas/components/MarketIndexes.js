const { computed, reactive, onMounted, onUnmounted } = Vue;
import { fetchQuote } from '../services/yahooFinance.js';
import { formatNumber, formatPct, changeClass } from '../utils/formatters.js';

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

/**
 * Markets → Markets: the major market indexes (config.marketIndexes.symbols),
 * refreshed every refresh interval; reports each refresh time (`updated`).
 * Your watchlists are in My Account → Watchlist.
 */
export default {
  name: 'MarketIndexes',
  props: { config: Object },
  emits: ['updated'],
  setup(props, { emit }) {
    // symbol → { price, change, pctChange, loading, error }
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
      emit('updated', new Date().toLocaleTimeString());
    }

    let timer = null;
    onMounted(() => {
      fetchIndexes();
      timer = setInterval(fetchIndexes, Math.max(30, props.config.ui?.refreshIntervalSeconds ?? 60) * 1000);
    });
    onUnmounted(() => clearInterval(timer));

    return { indexSymbols, indexes, INDEX_LABELS, formatNumber, formatPct, changeClass };
  },
  template: `
    <div>
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
      <p class="text-muted text-sm" style="margin:-12px 0 24px">Index quotes from Yahoo Finance, delayed 15–20 minutes. Your watchlists are in <strong>My Account → Watchlist</strong>.</p>
    </div>
  `,
};
