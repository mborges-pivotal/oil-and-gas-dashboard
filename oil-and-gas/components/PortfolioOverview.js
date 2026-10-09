const { ref, computed, watch } = Vue;
import PortfolioChart from './PortfolioChart.js';
import AllocationChart from './AllocationChart.js';
import { formatUSD } from '../utils/formatters.js';

/**
 * The card at the top of an opened portfolio (Account → Portfolios → one):
 *  - Performance: its all-time gain over time (PortfolioChart).
 *  - Holdings: the biggest holdings as one horizontal 100% stacked bar —
 *    the top 6 by value, the rest folded into "Other" — with a ranked list
 *    (the top 10) below it.
 *  - Sectors: the by-sector donut, as on the Summary.
 *  - By asset type (when `types` is given — the account Summary): that donut too.
 * Holdings, sectors and asset types switch between % of the total and $.
 * The tab and the %/$ choice are remembered per browser (per `storageKey`).
 * Anything in the default slot is shown under the sector / asset-type donuts.
 * pctOnly (a public portfolio's profile): percentages only — no $ toggle, no dollar values anywhere.
 */
const BAR_SEGMENTS = 6;   // + "Other" — categorical slots 1–6 keep their fixed order
const LIST_ROWS = 10;
const remembered = (key, ok, fallback) => {
  try { const v = localStorage.getItem(key); if (ok(v)) return v; } catch { /* none */ }
  return fallback;
};
const compactFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const compactUSD = v => (Math.abs(v) < 1000 ? formatUSD(v).replace(/\.\d+$/, '') : compactFmt.format(v));

export default {
  name: 'PortfolioOverview',
  components: { PortfolioChart, AllocationChart },
  props: {
    portfolio: Object, intraday: Object, quotes: Object, isCash: Function,
    holdings: { type: Array, default: null },  // [{ symbol, name, value }] — null while prices load
    sectors: { type: Array, default: null },   // donut slices (utils/allocation.js) — null while loading
    types: { type: Array, default: undefined }, // by-asset-type slices; adds that tab when given (null = loading)
    storageKey: { type: String, default: 'oilgas_pf_overview' },
    performanceTitle: { type: String, default: 'All-time gain' },
    pctOnly: Boolean,
  },
  setup(props) {
    const withTypes = props.types !== undefined;
    const TABS = [
      { id: 'performance', label: 'Performance', short: 'Performance' },
      { id: 'holdings', label: 'Holdings', short: 'Holdings' },
      { id: 'sectors', label: withTypes ? 'By sector' : 'Sectors', short: 'Sectors' },
      ...(withTypes ? [{ id: 'types', label: 'By asset type', short: 'Types' }] : []),
    ];
    const TAB_KEY = props.storageKey + '_tab';
    const MODE_KEY = props.storageKey + '_mode';
    const tab = ref(remembered(TAB_KEY, v => TABS.some(t => t.id === v), 'performance'));
    const savedMode = ref(remembered(MODE_KEY, v => v === 'pct' || v === 'usd', 'pct'));
    const mode = computed({ get: () => (props.pctOnly ? 'pct' : savedMode.value), set: v => { savedMode.value = v; } });
    watch(tab, v => { try { localStorage.setItem(TAB_KEY, v); } catch { /* per-browser only */ } });
    watch(savedMode, v => { try { localStorage.setItem(MODE_KEY, v); } catch { /* per-browser only */ } });

    const ranked = computed(() => [...(props.holdings ?? [])].filter(h => h.value > 0).sort((a, b) => b.value - a.value));
    const total = computed(() => ranked.value.reduce((s, h) => s + h.value, 0));
    const pctOf = v => (total.value ? (v / total.value) * 100 : 0);
    // Bar: the top holdings, each in its slot color; the remainder in gray.
    const segments = computed(() => {
      const top = ranked.value.slice(0, BAR_SEGMENTS).map((h, i) => ({ ...h, key: h.symbol, color: `var(--series-${i + 1})`, ink: `var(--series-${i + 1}-ink)`, pct: pctOf(h.value) }));
      const rest = ranked.value.slice(BAR_SEGMENTS);
      if (rest.length) {
        const value = rest.reduce((s, h) => s + h.value, 0);
        top.push({ key: '__other', symbol: `Other (${rest.length})`, name: rest.map(h => h.symbol).join(', '), value, color: 'var(--series-other)', ink: 'var(--series-other-ink)', pct: pctOf(value), other: true });
      }
      return top;
    });
    const list = computed(() => ranked.value.slice(0, LIST_ROWS).map((h, i) => ({
      ...h, rank: i + 1, pct: pctOf(h.value), color: i < BAR_SEGMENTS ? `var(--series-${i + 1})` : 'var(--series-other)',
    })));
    const moreCount = computed(() => Math.max(0, ranked.value.length - LIST_ROWS));
    const active = ref(null); // hovered segment / row
    const fmtPct = p => (p < 0.1 ? '<0.1%' : p.toFixed(1) + '%');
    const show = v => (mode.value === 'usd' ? formatUSD(v) : fmtPct(pctOf(v)));
    const second = v => (props.pctOnly ? '' : mode.value === 'usd' ? fmtPct(pctOf(v)) : formatUSD(v));
    const money = v => (props.pctOnly ? '' : ' · ' + formatUSD(v)); // the $ part of captions and tooltips
    const segLabel = s => (mode.value === 'usd' ? compactUSD(s.value) : fmtPct(s.pct));
    const activeSeg = computed(() => segments.value.find(s => s.key === active.value) ?? null);

    return { TABS, withTypes, tab, mode, money, ranked, total, segments, list, moreCount, active, activeSeg, show, second, segLabel, fmtPct, formatUSD };
  },
  template: `
    <div class="card pf-overview">
      <div class="pf-overview-head">
        <div class="subtab-bar pf-overview-tabs" role="tablist" aria-label="Portfolio views">
          <button v-for="t in TABS" :key="t.id" type="button" role="tab" class="subtab-btn"
                  :class="{ active: tab === t.id }" :aria-selected="tab === t.id" :aria-label="t.label" @click="tab = t.id"><span class="label-full">{{ t.label }}</span><span class="label-short" aria-hidden="true">{{ t.short }}</span></button>
        </div>
        <div class="range-btn-group pf-overview-mode" v-if="tab !== 'performance' && !pctOnly" role="group" aria-label="Show as">
          <button type="button" class="range-btn" :class="{ active: mode === 'pct' }" :aria-pressed="mode === 'pct'" @click="mode = 'pct'">%</button>
          <button type="button" class="range-btn" :class="{ active: mode === 'usd' }" :aria-pressed="mode === 'usd'" @click="mode = 'usd'">$</button>
        </div>
      </div>

      <!-- Performance -->
      <PortfolioChart v-if="tab === 'performance'" embedded :portfolio="portfolio" :intraday="intraday" :quotes="quotes" :is-cash="isCash" :title="performanceTitle" :storage-key="storageKey + '_range'" />

      <!-- Holdings: one 100% stacked bar + the ranked list -->
      <section v-else-if="tab === 'holdings'" class="pf-holdings-view" aria-label="Top holdings">
        <div class="skeleton" style="height:120px;margin-top:12px" v-if="holdings === null"></div>
        <p class="text-muted text-sm" v-else-if="!ranked.length" style="margin:12px 0 0">No holdings with a value yet.</p>
        <template v-else>
          <div class="hbar-caption">
            <template v-if="activeSeg"><strong>{{ activeSeg.symbol }}</strong> {{ activeSeg.other ? '' : activeSeg.name }}{{ money(activeSeg.value) }} · {{ fmtPct(activeSeg.pct) }}</template>
            <template v-else><template v-if="!pctOnly">Total {{ formatUSD(total) }} · </template>{{ ranked.length }} holding{{ ranked.length === 1 ? '' : 's' }}</template>
          </div>
          <div class="hbar" role="img" :aria-label="'Holdings by value: ' + segments.map(s => s.symbol + ' ' + fmtPct(s.pct)).join(', ')" @mouseleave="active = null">
            <span v-for="s in segments" :key="s.key" class="hbar-seg" :class="{ dim: active && active !== s.key, wide: s.pct >= 25 }"
                  :style="{ flexGrow: s.value, background: s.color, color: s.ink }" :title="s.symbol + money(s.value) + ' (' + fmtPct(s.pct) + ')'"
                  @mouseenter="active = s.key" @click="active = active === s.key ? null : s.key">
              <span class="hbar-label" v-if="s.pct >= 12">{{ s.other ? 'Other' : s.symbol }} {{ segLabel(s) }}</span>
            </span>
          </div>
          <ol class="hlist">
            <li v-for="h in list" :key="h.symbol" class="hlist-row" :class="{ active: active === h.symbol, dim: active && active !== h.symbol && !(active === '__other' && h.rank > 6) }"
                @mouseenter="active = h.rank <= 6 ? h.symbol : '__other'" @mouseleave="active = null">
              <span class="hlist-swatch" :style="{ background: h.color }" aria-hidden="true"></span>
              <span class="hlist-rank">{{ h.rank }}</span>
              <span class="hlist-id"><strong>{{ h.symbol }}</strong> <span class="text-muted">{{ h.name }}</span></span>
              <span class="hlist-minibar" aria-hidden="true"><span :style="{ width: Math.max(1, h.pct) + '%', background: h.color }"></span></span>
              <span class="hlist-main">{{ show(h.value) }}</span>
              <span class="hlist-second text-muted" v-if="!pctOnly">{{ second(h.value) }}</span>
            </li>
          </ol>
          <p class="text-muted text-sm hlist-note">
            <template v-if="moreCount">And {{ moreCount }} more. </template>By market value — stocks, funds and cash<template v-if="withTypes">, across all portfolios (a stock held in several counts once); option contracts are in each portfolio's Options card</template><template v-else-if="pctOnly"> holdings</template><template v-else> holdings; option contracts are on the Options card</template>.
          </p>
        </template>
      </section>

      <!-- By sector / by asset type: donuts -->
      <section v-else class="pf-sectors-view" :aria-label="tab === 'types' ? 'By asset type' : 'By sector'">
        <template v-for="slices in [tab === 'types' ? types : sectors]" :key="tab">
          <div class="skeleton allocation-skeleton" v-if="!slices"></div>
          <p class="text-muted text-sm" v-else-if="!slices.length" style="margin:12px 0 0">No holdings with a value yet.</p>
          <AllocationChart v-else :slices="slices" :mode="mode" :pct-only="pctOnly" :label="tab === 'types' ? 'Allocation by asset type' : 'Allocation by sector'" />
        </template>
        <p class="text-muted text-sm hlist-note" v-if="tab === 'types'">By current market value. Asset types come from Yahoo Finance — change one on a stock's Portfolio tab (e.g. a bond fund → Bonds).</p>
        <p class="text-muted text-sm hlist-note" v-else>Stocks by their sector, other holdings by type (fund sector breakdowns aren't available).</p>
        <slot></slot>
      </section>
    </div>
  `,
};
