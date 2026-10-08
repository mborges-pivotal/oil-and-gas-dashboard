const { ref, reactive, computed, watch, nextTick } = Vue;
import EconomicIndicators from './EconomicIndicators.js';
import OilGasMarkets from './OilGasMarkets.js';
import Stocks from './Stocks.js';

// `short` is shown on phones so all four sub-tabs fit without scrolling.
const SECTIONS = [
  { id: 'stocks', label: 'Stocks',              short: 'Stocks' },
  { id: 'econ',   label: 'Economic Indicators', short: 'Economy' },
  { id: 'oil',    label: 'Oil Price Indexes',   short: 'Oil' },
  { id: 'gas',    label: 'Retail Gas Prices',   short: 'Gas' },
];

/**
 * Markets tab — Stocks, Economic Indicators and Oil & Gas Markets under one
 * sub-tab bar (on touch screens, swipe the content left/right to switch). Oil and Gas share a single OilGasMarkets instance (it fetches
 * both on mount), so switching between those two doesn't refetch.
 */
export default {
  name: 'Markets',
  components: { EconomicIndicators, OilGasMarkets, Stocks },
  props: ['config', 'user'],
  emits: ['set-tickers', 'set-position', 'set-portfolios', 'go-account', 'go-notes'],
  setup() {
    const activeSection = ref('stocks'); // the first sub-tab
    // Last refresh time reported by each child, shown in the header row.
    const updated = reactive({ econ: null, oilgas: null, stocks: null });
    const lastUpdated = computed(() => {
      const s = activeSection.value;
      return s === 'oil' || s === 'gas' ? updated.oilgas : updated[s];
    });
    // On a phone the sub-tab row scrolls sideways — keep the active one visible.
    const subtabBar = ref(null);
    watch(activeSection, () => nextTick(() => {
      subtabBar.value?.querySelector('.subtab-btn.active')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }));

    // ── Swipe left/right on the content to change sub-tab (touch screens) ──
    // Touch events rather than pointer events: the page keeps its normal
    // vertical scrolling (touch-action stays auto), and touchend still fires
    // after the browser has taken over a scroll, where pointer events would
    // have been cancelled.
    const SWIPE_MIN_PX = 60;        // horizontal distance to count as a swipe
    const SWIPE_MAX_MS = 700;       // slower than this is a drag, not a flick
    const SWIPE_RATIO = 1.5;        // |dx| must clearly dominate |dy|
    const EDGE_PX = 24;             // leave screen edges to the OS back/forward gesture
    const slideFrom = ref('');      // 'left' | 'right' — entry animation for the new section
    let swipe = null;

    // Gestures that already mean something else start on these.
    function startsOnOwnGesture(target) {
      if (target.closest('.history-chart-svg, .drag-handle, input, select, textarea, .article-viewer')) return true;
      // Anything that scrolls sideways (wide tables, tab rows) keeps its swipe.
      for (let el = target; el && el !== document.body; el = el.parentElement) {
        if (el.scrollWidth > el.clientWidth + 1) {
          const ox = getComputedStyle(el).overflowX;
          if (ox === 'auto' || ox === 'scroll') return true;
        }
      }
      return false;
    }

    function onTouchStart(e) {
      swipe = null;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX < EDGE_PX || t.clientX > window.innerWidth - EDGE_PX) return;
      if (startsOnOwnGesture(e.target)) return;
      swipe = { x: t.clientX, y: t.clientY, time: Date.now() };
    }

    function onTouchEnd(e) {
      const s = swipe;
      swipe = null;
      if (!s || e.changedTouches.length !== 1) return;
      // A long-press card drag on the Stocks watchlist owns this gesture.
      if (document.querySelector('.watchlist.is-dragging')) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (Date.now() - s.time > SWIPE_MAX_MS) return;
      if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;
      const i = SECTIONS.findIndex(x => x.id === activeSection.value);
      const next = SECTIONS[i + (dx < 0 ? 1 : -1)];
      if (!next) return;
      slideFrom.value = dx < 0 ? 'right' : 'left';
      activeSection.value = next.id;
      // If the sub-tab row has scrolled away, bring it back so the new
      // section is seen from its top.
      nextTick(() => {
        const bar = subtabBar.value;
        const header = document.querySelector('.app-header');
        if (!bar) return;
        const top = bar.getBoundingClientRect().top - (header?.offsetHeight ?? 0) - 8;
        if (top < 0) window.scrollBy({ top, behavior: 'instant' });
      });
    }

    return {
      SECTIONS, activeSection, updated, lastUpdated, subtabBar,
      slideFrom, onTouchStart, onTouchEnd,
    };
  },
  template: `
    <div>
      <div class="flex-between mb-16">
        <div class="section-header" style="margin-bottom:0">Markets</div>
        <div class="text-muted text-sm" v-if="lastUpdated">Updated {{ lastUpdated }}</div>
      </div>

      <div class="subtab-bar subtab-bar-fit" ref="subtabBar">
        <button
          v-for="s in SECTIONS" :key="s.id"
          class="subtab-btn" :class="{ active: activeSection === s.id }"
          :aria-label="s.label" :title="s.label"
          @click="activeSection = s.id"
        ><span class="label-full">{{ s.label }}</span><span class="label-short" aria-hidden="true">{{ s.short }}</span></button>
      </div>

      <div class="markets-content" :class="slideFrom && 'slide-from-' + slideFrom"
           @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd"
           @animationend.self="slideFrom = ''">
        <EconomicIndicators v-if="activeSection === 'econ'" :config="config"
          @updated="updated.econ = $event" />
        <Stocks v-else-if="activeSection === 'stocks'" :config="config" :user="user"
          @updated="updated.stocks = $event"
          @set-tickers="$emit('set-tickers', $event)"
          @set-position="$emit('set-position', $event)" @set-portfolios="$emit('set-portfolios', $event)"
          @go-account="$emit('go-account')" @go-notes="$emit('go-notes')" />
        <OilGasMarkets v-else :config="config" :section="activeSection"
          @updated="updated.oilgas = $event" />
      </div>
    </div>
  `,
};
