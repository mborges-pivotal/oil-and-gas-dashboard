const { ref, reactive, computed, watch, nextTick } = Vue;
import EconomicIndicators from './EconomicIndicators.js';
import OilGasMarkets from './OilGasMarkets.js';
import MarketIndexes from './MarketIndexes.js';
import News from './News.js';

// `short` is shown on phones so all the sub-tabs fit without scrolling.
// Shown in the app's subheader (app.js), after My Account.
export const SECTIONS = [
  { id: 'markets', label: 'Markets', short: 'Markets' },
  { id: 'econ',    label: 'Economy', short: 'Economy' },
  { id: 'energy',  label: 'Energy',  short: 'Energy' },
];
// Energy's own tabs (remembered per browser).
const ENERGY_TABS = [
  { id: 'oil', label: 'Oil Price Indexes', short: 'Oil prices' },
  { id: 'gas', label: 'Retail Gas Prices', short: 'Gas prices' },
];
const ENERGY_KEY = 'oilgas_energy_tab';

/**
 * Markets (the home page) — Markets (the major indexes, with News under them), Economy and Energy;
 * watchlists are in My Account → Watchlist. The sub-tabs live in the app's
 * frozen subheader (app.js), which owns the open section (v-model:section) and
 * shows the last-updated time this reports (updated-time); on touch screens,
 * swipe the content left/right to switch. Energy has its own tabs — Oil Price
 * Indexes · Retail Gas Prices — sharing a single OilGasMarkets instance (it
 * fetches both on mount), so switching between them doesn't refetch.
 */
export default {
  name: 'Markets',
  components: { EconomicIndicators, OilGasMarkets, MarketIndexes, News },
  props: { config: Object, user: Object, section: { type: String, default: 'markets' } },
  emits: ['update:section', 'updated-time'],
  setup(props, { emit }) {
    const activeSection = computed({
      get: () => (SECTIONS.some(s => s.id === props.section) ? props.section : 'markets'),
      set: id => emit('update:section', id),
    });
    // Last refresh time reported by each child, shown in the header row.
    const updated = reactive({ econ: null, energy: null, markets: null });
    const lastUpdated = computed(() => updated[activeSection.value]);
    const energyTab = ref((() => {
      try { const v = localStorage.getItem(ENERGY_KEY); if (ENERGY_TABS.some(t => t.id === v)) return v; } catch { /* none saved */ }
      return 'oil';
    })());
    watch(energyTab, v => { try { localStorage.setItem(ENERGY_KEY, v); } catch { /* per-browser only */ } });
    watch(lastUpdated, t => emit('updated-time', t), { immediate: true });

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
      // Scrolled down: bring the new section's top up to just under the
      // (frozen) subheader so it's seen from the start.
      nextTick(() => {
        const sub = document.querySelector('.app-subheader');
        const content = document.querySelector('.markets-content');
        if (!sub || !content) return;
        const top = content.getBoundingClientRect().top - sub.getBoundingClientRect().bottom - 12;
        if (top < 0) window.scrollBy({ top, behavior: 'instant' });
      });
    }

    return {
      SECTIONS, ENERGY_TABS, energyTab, activeSection, updated, lastUpdated,
      slideFrom, onTouchStart, onTouchEnd,
    };
  },
  template: `
    <div>
      <div class="markets-content" :class="slideFrom && 'slide-from-' + slideFrom"
           @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd"
           @animationend.self="slideFrom = ''">
        <EconomicIndicators v-if="activeSection === 'econ'" :config="config"
          @updated="updated.econ = $event" />
        <template v-else-if="activeSection === 'markets'">
          <MarketIndexes :config="config" @updated="updated.markets = $event" />
          <News :config="config" embedded />
        </template>
        <template v-else>
          <div class="subtab-bar energy-tabs" role="tablist" aria-label="Energy">
            <button v-for="t in ENERGY_TABS" :key="t.id" type="button" role="tab" class="subtab-btn"
                    :class="{ active: energyTab === t.id }" :aria-selected="energyTab === t.id" :aria-label="t.label"
                    @click="energyTab = t.id"><span class="label-full">{{ t.label }}</span><span class="label-short" aria-hidden="true">{{ t.short }}</span></button>
          </div>
          <OilGasMarkets :config="config" :section="energyTab" @updated="updated.energy = $event" />
        </template>
      </div>
    </div>
  `,
};
