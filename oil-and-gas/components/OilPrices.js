const { ref, reactive, onMounted, onUnmounted, computed, watch } = Vue;
import { fetchQuote, fetchChart } from '../services/yahooFinance.js';
import { calcSpread } from '../utils/spread.js';
import { formatUSD, formatPct, formatDate, changeClass } from '../utils/formatters.js';
import { RANGE_OPTIONS, cutoffDateFor, monthlyTicks, dropEdgeTickCollisions } from '../utils/dateRange.js';

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

// ── Spread history chart — two price lines (Index A / Index B) with the ──
// gap between them filled, colored by which one is on top at each point.
// The fill is built as explicit polygons per segment rather than via
// clipPath (which only works against a constant reference like zero):
// wherever the two lines cross between consecutive points, the crossing x
// is found by linear interpolation and the segment is split there, so the
// color boundary lands exactly on the crossing instead of jumping at the
// nearest data point.
const SpreadHistoryChart = {
  props: ['data', 'labelA', 'labelB'], // ascending array of { period, a, b }
  setup(props) {
    const width = 720, height = 260;
    const padding = { top: 16, right: 16, bottom: 26, left: 64 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;

    const hoverIndex = ref(null);

    const allValues = computed(() => props.data.flatMap(d => [Number(d.a), Number(d.b)]));
    const minV = computed(() => (allValues.value.length ? Math.min(...allValues.value) : 0));
    const maxV = computed(() => (allValues.value.length ? Math.max(...allValues.value) : 1));
    const yPad = computed(() => (maxV.value - minV.value) * 0.12 || 1);
    const yMin = computed(() => minV.value - yPad.value);
    const yMax = computed(() => maxV.value + yPad.value);

    function xAt(i) {
      const n = props.data.length;
      return padding.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    }
    function yAt(v) {
      const range = yMax.value - yMin.value || 1;
      return padding.top + plotH - ((v - yMin.value) / range) * plotH;
    }

    const lineAPath = computed(() =>
      props.data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)},${yAt(Number(d.a)).toFixed(1)}`).join(' ')
    );
    const lineBPath = computed(() =>
      props.data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)},${yAt(Number(d.b)).toFixed(1)}`).join(' ')
    );

    // One quad per segment between consecutive points, split at the A/B
    // crossing when the segment changes sign. yAt is affine, so pixel-space
    // interpolation of the crossing (`t`) lands on the same point as
    // interpolating in value-space first and converting — no need to do both.
    const fillPaths = computed(() => {
      const pos = [];
      const neg = [];
      const n = props.data.length;
      for (let i = 0; i < n - 1; i++) {
        const d0 = props.data[i], d1 = props.data[i + 1];
        const a0 = Number(d0.a), b0 = Number(d0.b), a1 = Number(d1.a), b1 = Number(d1.b);
        const diff0 = a0 - b0, diff1 = a1 - b1;
        const x0 = xAt(i), x1 = xAt(i + 1);
        const ay0 = yAt(a0), by0 = yAt(b0), ay1 = yAt(a1), by1 = yAt(b1);

        if ((diff0 >= 0 && diff1 >= 0) || (diff0 <= 0 && diff1 <= 0)) {
          const quad = `M ${x0.toFixed(1)},${ay0.toFixed(1)} L ${x1.toFixed(1)},${ay1.toFixed(1)} L ${x1.toFixed(1)},${by1.toFixed(1)} L ${x0.toFixed(1)},${by0.toFixed(1)} Z`;
          (diff0 + diff1 >= 0 ? pos : neg).push(quad);
        } else {
          const t = diff0 / (diff0 - diff1);
          const xc = x0 + (x1 - x0) * t;
          const yc = ay0 + (ay1 - ay0) * t;
          const tri1 = `M ${x0.toFixed(1)},${ay0.toFixed(1)} L ${xc.toFixed(1)},${yc.toFixed(1)} L ${x0.toFixed(1)},${by0.toFixed(1)} Z`;
          const tri2 = `M ${xc.toFixed(1)},${yc.toFixed(1)} L ${x1.toFixed(1)},${ay1.toFixed(1)} L ${x1.toFixed(1)},${by1.toFixed(1)} Z`;
          (diff0 >= 0 ? pos : neg).push(tri1);
          (diff1 >= 0 ? pos : neg).push(tri2);
        }
      }
      return { positive: pos.join(' '), negative: neg.join(' ') };
    });

    const yTicks = computed(() => {
      const n = 4;
      const ticks = [];
      for (let i = 0; i <= n; i++) ticks.push(yMin.value + (i / n) * (yMax.value - yMin.value));
      return ticks;
    });

    // Monthly labels, thinned to fit — see monthlyTicks() for how it avoids
    // crowding on wide ranges.
    const xTickLabels = computed(() => {
      const ticks = monthlyTicks(props.data, 15);
      const mapped = ticks.map((t, pos) => ({
        i: t.i,
        x: xAt(t.i),
        label: t.label,
        anchor: pos === 0 ? 'start' : (pos === ticks.length - 1 ? 'end' : 'middle'),
      }));
      return dropEdgeTickCollisions(mapped);
    });

    function onMove(evt) {
      if (!props.data.length) return;
      const rect = evt.currentTarget.getBoundingClientRect();
      const px = (evt.clientX - rect.left) * (width / rect.width);
      const n = props.data.length;
      const rel = n <= 1 ? 0 : (px - padding.left) / plotW;
      hoverIndex.value = Math.min(Math.max(Math.round(rel * (n - 1)), 0), n - 1);
    }
    function onLeave() { hoverIndex.value = null; }

    const hoverPoint = computed(() => (hoverIndex.value === null ? null : props.data[hoverIndex.value]));
    const hoverX = computed(() => (hoverIndex.value === null ? 0 : xAt(hoverIndex.value)));
    const hoverSpread = computed(() => (hoverPoint.value ? Number(hoverPoint.value.a) - Number(hoverPoint.value.b) : null));
    const tooltipLeftPct = computed(() => Math.min(Math.max((hoverX.value / width) * 100, 8), 92));

    const lastIndex = computed(() => props.data.length - 1);
    const lastPoint = computed(() => props.data[lastIndex.value] ?? null);

    return {
      width, height, padding, plotW, plotH,
      lineAPath, lineBPath, fillPaths,
      yTicks, xTickLabels, xAt, yAt,
      onMove, onLeave, hoverPoint, hoverX, hoverSpread, tooltipLeftPct,
      lastIndex, lastPoint,
      formatUSD, formatDate,
    };
  },
  template: `
    <div class="history-chart-wrap">
      <div class="chart-legend">
        <span class="legend-item"><span class="legend-swatch" style="background:var(--accent)"></span>{{ labelA }}</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--warning)"></span>{{ labelB }}</span>
      </div>
      <svg :viewBox="'0 0 ' + width + ' ' + height" class="history-chart-svg"
           @mousemove="onMove" @mouseleave="onLeave">
        <g v-for="(t, i) in yTicks" :key="'grid'+i">
          <line :x1="padding.left" :x2="width - padding.right" :y1="yAt(t)" :y2="yAt(t)" class="chart-gridline" />
          <text :x="padding.left - 8" :y="yAt(t) + 3" class="chart-axis-label" text-anchor="end">{{ formatUSD(t) }}</text>
        </g>
        <text v-for="t in xTickLabels" :key="'xt'+t.i" :x="t.x" :y="height - 8" class="chart-axis-label" :text-anchor="t.anchor">
          {{ t.label }}
        </text>

        <path :d="fillPaths.positive" class="chart-area-positive" />
        <path :d="fillPaths.negative" class="chart-area-negative" />

        <path :d="lineAPath" class="chart-line-a" fill="none" />
        <path :d="lineBPath" class="chart-line-b" fill="none" />

        <circle v-if="lastPoint" :cx="xAt(lastIndex)" :cy="yAt(Number(lastPoint.a))" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" />
        <circle v-if="lastPoint" :cx="xAt(lastIndex)" :cy="yAt(Number(lastPoint.b))" r="4" fill="var(--warning)" stroke="var(--surface)" stroke-width="2" />
        <line v-if="hoverPoint" :x1="hoverX" :x2="hoverX" :y1="padding.top" :y2="height - padding.bottom" class="chart-crosshair" />
      </svg>
      <div v-if="hoverPoint" class="chart-tooltip" :style="{ left: tooltipLeftPct + '%' }">
        <div class="chart-tooltip-row"><span class="legend-swatch" style="background:var(--accent)"></span>{{ labelA }}: {{ formatUSD(Number(hoverPoint.a)) }}</div>
        <div class="chart-tooltip-row"><span class="legend-swatch" style="background:var(--warning)"></span>{{ labelB }}: {{ formatUSD(Number(hoverPoint.b)) }}</div>
        <div class="chart-tooltip-value" :class="hoverSpread >= 0 ? 'positive' : 'negative'">Spread: {{ formatUSD(hoverSpread) }}</div>
        <div class="chart-tooltip-date">{{ formatDate(hoverPoint.period) }}</div>
      </div>
    </div>
  `,
};

export default {
  name: 'OilPrices',
  components: { SpreadHistoryChart },
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
          <SpreadHistoryChart :data="filteredSpreadHistory"
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
