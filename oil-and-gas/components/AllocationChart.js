const { ref, computed } = Vue;
import { formatUSD } from '../utils/formatters.js';

/**
 * Donut chart + compact legend for a part-to-whole breakdown (Portfolio
 * page: by asset category / by sector) — inline SVG, no chart library.
 *
 * slices: [{ key, label, short?, value, symbols, other, slot? }] in display
 * order (see utils/allocation.js buildSlices, which caps them at 6). A
 * slice's color is its slot (--series-N, from assignSlots) — fixed per
 * category so it matches across charts — else the next slot in order;
 * "Other" is gray.
 *
 * Big slices (≥ LABEL_MIN_PCT) carry their % on the ring, in an ink chosen
 * per slot for contrast (--series-N-ink). The legend names every slice with
 * its % and a compact $ (identity never rests on color alone); hovering or
 * tapping a slice / legend item shows its exact value and holdings in the
 * center. A visually hidden table carries the full data for screen readers.
 */
const LABEL_MIN_PCT = 10;
// $6.6K, $1.2M — and whole dollars under $1,000 ($901), to keep legend items short.
const compactFmt = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1,
});
const wholeFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
function compactUSD(v) {
  return Math.abs(v) < 1000 ? wholeFmt.format(v) : compactFmt.format(v);
}

export default {
  name: 'AllocationChart',
  // mode: 'pct' (default) labels the ring with percentages; 'usd' with
  // compact dollars, and the legend leads with the dollar amount.
  // pctOnly: percentages only, never dollar values (a public portfolio's profile)
  props: { slices: Array, label: String, mode: { type: String, default: 'pct' }, pctOnly: Boolean },
  setup(props) {
    const SIZE = 180;
    const C = SIZE / 2;
    const R_OUTER = 84;
    const R_INNER = 54;
    const R_LABEL = (R_OUTER + R_INNER) / 2;
    const active = ref(null); // slice key under hover / tap

    const total = computed(() => props.slices.reduce((sum, s) => sum + s.value, 0));

    function slotFor(slice, i) {
      if (slice.other) return 'other';
      if (slice.slot) return slice.slot;
      return (props.slices.slice(0, i).filter(s => !s.other).length % 8) + 1;
    }

    function point(r, angle) {
      return [C + r * Math.sin(angle), C - r * Math.cos(angle)];
    }

    // Annular sector from a0 to a1 (radians clockwise from 12 o'clock).
    function arcPath(a0, a1) {
      // A full ring can't be one arc (start = end); split it in two.
      if (a1 - a0 >= Math.PI * 2 - 1e-6) {
        return arcPath(a0, a0 + Math.PI) + ' ' + arcPath(a0 + Math.PI, a1);
      }
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const [x0, y0] = point(R_OUTER, a0);
      const [x1, y1] = point(R_OUTER, a1);
      const [x2, y2] = point(R_INNER, a1);
      const [x3, y3] = point(R_INNER, a0);
      return `M${x0.toFixed(2)},${y0.toFixed(2)} A${R_OUTER},${R_OUTER} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} `
        + `L${x2.toFixed(2)},${y2.toFixed(2)} A${R_INNER},${R_INNER} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)} Z`;
    }

    const arcs = computed(() => {
      let angle = 0;
      return props.slices.map((s, i) => {
        const sweep = total.value ? (s.value / total.value) * Math.PI * 2 : 0;
        const d = arcPath(angle, angle + sweep);
        const [lx, ly] = point(R_LABEL, angle + sweep / 2);
        angle += sweep;
        const slot = slotFor(s, i);
        const pct = total.value ? (s.value / total.value) * 100 : 0;
        return {
          ...s, d, pct,
          name: s.short || s.label,
          color: `var(--series-${slot})`,
          ink: `var(--series-${slot}-ink)`,
          labelAt: pct >= LABEL_MIN_PCT ? { x: lx, y: ly } : null,
        };
      });
    });

    const activeArc = computed(() => arcs.value.find(a => a.key === active.value) ?? null);

    function toggle(key) {
      active.value = active.value === key ? null : key;
    }

    const ariaLabel = computed(() =>
      `${props.label}: ` + arcs.value.map(a => `${a.label} ${a.pct.toFixed(1)}%`).join(', ')
    );

    function pctText(p) {
      return p >= 10 || p === 0 ? `${p.toFixed(0)}%` : `${p.toFixed(1)}%`;
    }

    return {
      SIZE, active, total, arcs, activeArc, toggle, ariaLabel, pctText,
      formatUSD, compactUSD,
    };
  },
  template: `
    <div class="allocation" @mouseleave="active = null">
      <div class="allocation-donut-wrap">
        <svg class="allocation-donut" :viewBox="'0 0 ' + SIZE + ' ' + SIZE" aria-hidden="true">
          <path v-for="a in arcs" :key="a.key" :d="a.d" :fill="a.color"
                class="allocation-slice" :class="{ dim: active && active !== a.key }"
                @mouseenter="active = a.key" @click="toggle(a.key)" />
          <template v-for="a in arcs" :key="'l' + a.key">
            <text v-if="a.labelAt" :x="a.labelAt.x" :y="a.labelAt.y" :fill="a.ink"
                  class="allocation-slice-label" :class="{ dim: active && active !== a.key }"
                  text-anchor="middle" dominant-baseline="central">{{ mode === 'usd' ? compactUSD(a.value) : pctText(a.pct) }}</text>
          </template>
        </svg>
        <!-- Center: total, or the hovered / tapped slice in full -->
        <div class="allocation-center" aria-live="polite">
          <template v-if="activeArc">
            <div class="allocation-center-label">{{ activeArc.label }}</div>
            <div class="allocation-center-value">{{ pctOnly ? pctText(activeArc.pct) : formatUSD(activeArc.value) }}</div>
            <div class="allocation-center-symbols" v-if="activeArc.symbols.length">{{ activeArc.symbols.join(', ') }}</div>
          </template>
          <template v-else>
            <div class="allocation-center-label">{{ pctOnly ? 'Groups' : 'Total' }}</div>
            <div class="allocation-center-value">{{ pctOnly ? arcs.length : formatUSD(total) }}</div>
          </template>
        </div>
      </div>

      <ul class="allocation-legend" aria-hidden="true">
        <li v-for="a in arcs" :key="a.key" :title="a.label + ' — ' + (pctOnly ? pctText(a.pct) : formatUSD(a.value)) + (a.symbols.length ? ' (' + a.symbols.join(', ') + ')' : '')"
            :class="{ active: active === a.key, dim: active && active !== a.key }"
            @mouseenter="active = a.key" @click="toggle(a.key)">
          <span class="allocation-swatch" :style="{ background: a.color }"></span>
          <span class="allocation-name">{{ a.name }}</span>
          <span class="allocation-pct">{{ mode === 'usd' ? compactUSD(a.value) : pctText(a.pct) }}</span>
          <span class="allocation-value" v-if="!pctOnly">{{ mode === 'usd' ? pctText(a.pct) : compactUSD(a.value) }}</span>
        </li>
      </ul>

      <!-- Full data for screen readers (the chart and legend above are hidden from them) -->
      <table class="sr-only">
        <caption>{{ ariaLabel }}</caption>
        <thead><tr><th>Group</th><th>Holdings</th><th v-if="!pctOnly">Value</th><th>Share</th></tr></thead>
        <tbody>
          <tr v-for="a in arcs" :key="'t' + a.key">
            <td>{{ a.label }}</td><td>{{ a.symbols.join(', ') }}</td><td v-if="!pctOnly">{{ formatUSD(a.value) }}</td><td>{{ pctText(a.pct) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `,
};
