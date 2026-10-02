const { ref, reactive, computed, watch, nextTick } = Vue;
import EconomicIndicators from './EconomicIndicators.js';
import OilGasMarkets from './OilGasMarkets.js';
import Stocks from './Stocks.js';

const SECTIONS = [
  { id: 'econ', label: 'Economic Indicators' },
  { id: 'oil',  label: 'Oil Price Indexes' },
  { id: 'gas',  label: 'Retail Gas Prices' },
  { id: 'stocks', label: 'Stocks' },
];

/**
 * Markets tab — Economic Indicators, Oil & Gas Markets and Stocks under one
 * sub-tab bar. Oil and Gas share a single OilGasMarkets instance (it fetches
 * both on mount), so switching between those two doesn't refetch.
 */
export default {
  name: 'Markets',
  components: { EconomicIndicators, OilGasMarkets, Stocks },
  props: ['config'],
  emits: ['reorder-tickers'],
  setup() {
    const activeSection = ref('econ');
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
    return { SECTIONS, activeSection, updated, lastUpdated, subtabBar };
  },
  template: `
    <div>
      <div class="flex-between mb-16">
        <div class="section-header" style="margin-bottom:0">Markets</div>
        <div class="text-muted text-sm" v-if="lastUpdated">Updated {{ lastUpdated }}</div>
      </div>

      <div class="subtab-bar" ref="subtabBar">
        <button
          v-for="s in SECTIONS" :key="s.id"
          class="subtab-btn" :class="{ active: activeSection === s.id }"
          @click="activeSection = s.id"
        >{{ s.label }}</button>
      </div>

      <EconomicIndicators v-if="activeSection === 'econ'" :config="config"
        @updated="updated.econ = $event" />
      <Stocks v-else-if="activeSection === 'stocks'" :config="config"
        @updated="updated.stocks = $event"
        @reorder-tickers="$emit('reorder-tickers', $event)" />
      <OilGasMarkets v-else :config="config" :section="activeSection"
        @updated="updated.oilgas = $event" />
    </div>
  `,
};
