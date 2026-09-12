const { ref, computed } = Vue;
import { formatUSD, formatDate } from '../utils/formatters.js';
import { monthlyTicks, dropEdgeTickCollisions } from '../utils/dateRange.js';

/**
 * Generic two-series historical overlay chart — inline SVG, no chart
 * library. Plots two actual value lines (A / B) with the gap between them
 * filled, colored by which one is on top at each point — the classic way
 * to show a spread as "both legs plus their crossing" rather than just the
 * difference. Shared by Oil Prices (index A vs index B) and Economic
 * Indicators (10Y vs 2Y Treasury yield curve).
 *
 * The fill is built as explicit polygons per segment rather than via
 * clipPath (which only works against a constant reference like zero):
 * wherever the two lines cross between consecutive points, the crossing x
 * is found by linear interpolation and the segment is split there, so the
 * color boundary lands exactly on the crossing instead of jumping at the
 * nearest data point.
 *
 * `formatValue` lets callers pick the axis/tooltip formatter (defaults to
 * USD) — e.g. Economic Indicators passes a percent formatter instead.
 */
export default {
  name: 'DualLineChart',
  props: ['data', 'labelA', 'labelB', 'formatValue'], // data: ascending array of { period, a, b }
  setup(props) {
    const width = 720, height = 260;
    const padding = { top: 16, right: 16, bottom: 26, left: 64 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;

    const fmt = computed(() => props.formatValue ?? formatUSD);

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
      lineAPath, lineBPath, fillPaths, fmt,
      yTicks, xTickLabels, xAt, yAt,
      onMove, onLeave, hoverPoint, hoverX, hoverSpread, tooltipLeftPct,
      lastIndex, lastPoint,
      formatDate,
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
          <text :x="padding.left - 8" :y="yAt(t) + 3" class="chart-axis-label" text-anchor="end">{{ fmt(t) }}</text>
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
        <div class="chart-tooltip-row"><span class="legend-swatch" style="background:var(--accent)"></span>{{ labelA }}: {{ fmt(Number(hoverPoint.a)) }}</div>
        <div class="chart-tooltip-row"><span class="legend-swatch" style="background:var(--warning)"></span>{{ labelB }}: {{ fmt(Number(hoverPoint.b)) }}</div>
        <div class="chart-tooltip-value" :class="hoverSpread >= 0 ? 'positive' : 'negative'">Spread: {{ fmt(hoverSpread) }}</div>
        <div class="chart-tooltip-date">{{ formatDate(hoverPoint.period) }}</div>
      </div>
    </div>
  `,
};
