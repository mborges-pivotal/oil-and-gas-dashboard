const { ref, computed } = Vue;
import { formatUSD, formatPct, formatDate } from '../utils/formatters.js';
import { monthlyTicks, dropEdgeTickCollisions } from '../utils/dateRange.js';

/**
 * Generic single-series historical line chart — inline SVG, no chart
 * library. Shared by Gas Prices (retail price history) and Economic
 * Indicators (FRED series history); anything else plotting an ascending
 * { period, value } series over time can reuse it too.
 *
 * `formatValue` lets callers pick the axis/tooltip formatter (defaults to
 * USD) — e.g. Economic Indicators passes a percent formatter instead.
 */
export default {
  name: 'HistoryChart',
  props: ['data', 'formatValue'], // data: ascending array of { period, value }
  setup(props) {
    const width = 720, height = 260;
    const padding = { top: 16, right: 16, bottom: 26, left: 56 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;

    const fmt = computed(() => props.formatValue ?? formatUSD);

    const hoverIndex = ref(null);

    const values = computed(() => props.data.map(d => Number(d.value)));
    const minV = computed(() => (values.value.length ? Math.min(...values.value) : 0));
    const maxV = computed(() => (values.value.length ? Math.max(...values.value) : 1));
    const yPad = computed(() => (maxV.value - minV.value) * 0.12 || 0.1);
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

    const linePath = computed(() =>
      props.data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)},${yAt(Number(d.value)).toFixed(1)}`).join(' ')
    );

    const yTicks = computed(() => {
      const n = 4;
      const ticks = [];
      for (let i = 0; i <= n; i++) ticks.push(yMin.value + (i / n) * (yMax.value - yMin.value));
      return ticks;
    });

    // Monthly labels, thinned to fit — see monthlyTicks() for how it avoids
    // crowding on wide ranges. Built as one computed (not indices into a
    // separately-exposed `data` array) so it can't desync from props.data
    // when the parent swaps in a differently-sized array on range change.
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
    const hoverY = computed(() => (hoverIndex.value === null ? 0 : yAt(Number(hoverPoint.value.value))));
    const tooltipLeftPct = computed(() => Math.min(Math.max((hoverX.value / width) * 100, 8), 92));

    const lastIndex = computed(() => props.data.length - 1);
    const lastPoint = computed(() => props.data[lastIndex.value] ?? null);
    const firstPoint = computed(() => props.data[0] ?? null);

    // Change over the currently selected range (first vs. last visible
    // point) — not a day-over-day change, so it tracks whatever range
    // button (1M/1Y/5Y/...) the parent has selected.
    const periodChange = computed(() => {
      if (!firstPoint.value || !lastPoint.value) return null;
      const first = Number(firstPoint.value.value);
      const last = Number(lastPoint.value.value);
      if (!first) return null;
      return { abs: last - first, pct: ((last - first) / Math.abs(first)) * 100 };
    });

    return {
      width, height, padding, plotW, plotH,
      linePath, yTicks, xTickLabels, xAt, yAt, fmt,
      onMove, onLeave, hoverPoint, hoverX, hoverY, tooltipLeftPct,
      lastIndex, lastPoint, periodChange,
      formatDate, formatPct,
    };
  },
  template: `
    <div class="history-chart-wrap">
      <div class="chart-corner-label" v-if="lastPoint">
        <span class="chart-corner-value">{{ fmt(Number(lastPoint.value)) }}</span>
        <span v-if="periodChange" class="chart-corner-change" :class="periodChange.pct >= 0 ? 'positive' : 'negative'">
          {{ formatPct(periodChange.pct) }}
        </span>
      </div>
      <svg :viewBox="'0 0 ' + width + ' ' + height" class="history-chart-svg"
           @mousemove="onMove" @mouseleave="onLeave">
        <g v-for="(t, i) in yTicks" :key="'grid'+i">
          <line :x1="padding.left" :x2="width - padding.right" :y1="yAt(t)" :y2="yAt(t)" class="chart-gridline" />
          <text :x="padding.left - 8" :y="yAt(t) + 3" class="chart-axis-label" text-anchor="end">{{ fmt(t) }}</text>
        </g>
        <text v-for="t in xTickLabels" :key="'xt'+t.i" :x="t.x" :y="height - 8" class="chart-axis-label" :text-anchor="t.anchor">
          {{ t.label }}
        </text>
        <path :d="linePath" class="chart-line" fill="none" />
        <circle v-if="lastPoint" :cx="xAt(lastIndex)" :cy="yAt(Number(lastPoint.value))" r="4" class="chart-end-dot" />
        <template v-if="hoverPoint">
          <line :x1="hoverX" :x2="hoverX" :y1="padding.top" :y2="height - padding.bottom" class="chart-crosshair" />
          <circle :cx="hoverX" :cy="hoverY" r="4" class="chart-hover-dot" />
        </template>
      </svg>
      <div v-if="hoverPoint" class="chart-tooltip" :style="{ left: tooltipLeftPct + '%' }">
        <div class="chart-tooltip-value">{{ fmt(Number(hoverPoint.value)) }}</div>
        <div class="chart-tooltip-date">{{ formatDate(hoverPoint.period) }}</div>
      </div>
    </div>
  `,
};
