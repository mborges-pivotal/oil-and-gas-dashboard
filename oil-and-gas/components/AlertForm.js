const { ref, computed, onMounted } = Vue;
import { ALERT_KINDS } from '../utils/alerts.js';
import { formatUSD } from '../utils/formatters.js';

/**
 * Create / edit one stock alert (stock card → 🔔 tab). `initial` is an
 * existing alert or a preset ({ kind, params, repeat?, note? }); `quote` is
 * the stock's current quote (price, 52-week range) and `avgCost` its
 * Portfolio average cost, if held — both used for prefills and the live
 * "= $172.21" helpers. Emits save({ kind, params, repeat, note }) and cancel.
 */
export default {
  name: 'AlertForm',
  props: {
    symbol: String,
    quote: Object,
    avgCost: { type: Number, default: null },
    initial: { type: Object, default: () => ({ kind: 'price', params: { direction: 'above', basis: 'percent', percent: 5 } }) },
    submitLabel: { type: String, default: 'Save alert' },
    busy: Boolean,
    error: String,
  },
  emits: ['save', 'cancel'],
  setup(props, { emit }) {
    const p0 = props.initial.params ?? {};
    const kind = ref(props.initial.kind ?? 'price');
    const repeat = ref(props.initial.repeat ?? 'once');
    const note = ref(props.initial.note ?? '');
    const localError = ref(null);
    const firstInput = ref(null);

    const price = computed(() => props.quote?.price ?? null);

    // Price target: direction + either a $ value or a % from a base price.
    const priceDir = ref(p0.direction === 'below' ? 'below' : 'above');
    const priceMode = ref(p0.basis === 'fixed' ? 'fixed' : 'percent');
    const priceValue = ref(p0.basis === 'fixed' ? String(p0.target ?? '') : String(Math.abs(p0.percent ?? 5)));
    // Editing a % alert keeps its original base; new ones use today's price.
    const basePrice = computed(() => (p0.basis === 'percent' && p0.basePrice) || price.value);

    // Other kinds
    const dailyDir = ref(['up', 'down', 'either'].includes(p0.direction) ? p0.direction : 'up');
    const posDir = ref(p0.direction === 'loss' ? 'loss' : 'gain');
    const percent = ref(String(p0.percent != null && kind.value !== 'price' ? Math.abs(p0.percent) : (kind.value === 'position' ? 20 : 3)));
    const within = ref(String(p0.within ?? 0));
    const multiple = ref(String(p0.multiple ?? 2));

    const n = v => (String(v).trim() === '' ? NaN : Number(v));

    const priceTarget = computed(() => {
      const v = n(priceValue.value);
      if (!Number.isFinite(v)) return null;
      if (priceMode.value === 'fixed') return v;
      if (!basePrice.value) return null;
      return basePrice.value * (1 + (priceDir.value === 'above' ? v : -v) / 100);
    });

    const helper = computed(() => {
      switch (kind.value) {
        case 'price': {
          if (priceTarget.value == null) return '';
          if (priceMode.value === 'percent') return `= ${formatUSD(priceTarget.value)} (from ${formatUSD(basePrice.value)})`;
          if (!price.value) return '';
          const d = ((priceTarget.value - price.value) / price.value) * 100;
          return `${d >= 0 ? '+' : ''}${d.toFixed(1)}% from the current ${formatUSD(price.value)}`;
        }
        case 'position': {
          if (!props.avgCost) return '';
          const v = n(percent.value);
          if (!Number.isFinite(v)) return '';
          const at = props.avgCost * (1 + (posDir.value === 'gain' ? v : -v) / 100);
          return `Triggers at ${formatUSD(at)} (your average cost is ${formatUSD(props.avgCost)})`;
        }
        case 'high52':
        case 'low52': {
          const ref52 = kind.value === 'high52' ? props.quote?.fiftyTwoWeekHigh : props.quote?.fiftyTwoWeekLow;
          if (!ref52) return '';
          const w = n(within.value) || 0;
          const at = kind.value === 'high52' ? ref52 * (1 - w / 100) : ref52 * (1 + w / 100);
          return `52-week ${kind.value === 'high52' ? 'high' : 'low'} is ${formatUSD(ref52)}`
            + (w ? ` — triggers ${kind.value === 'high52' ? 'at or above' : 'at or below'} ${formatUSD(at)}` : '');
        }
        default:
          return '';
      }
    });

    function fail(msg) {
      localError.value = msg;
      return null;
    }

    function buildParams() {
      switch (kind.value) {
        case 'price': {
          const v = n(priceValue.value);
          if (!(v > 0)) return fail(priceMode.value === 'fixed' ? 'Enter a target price above 0.' : 'Enter a percentage above 0.');
          if (priceMode.value === 'fixed') return { direction: priceDir.value, basis: 'fixed', target: v };
          if (!basePrice.value) return fail("The current price hasn't loaded yet — try again in a moment, or use a $ value.");
          if (priceDir.value === 'below' && v >= 100) return fail('A drop must be less than 100%.');
          return { direction: priceDir.value, basis: 'percent', percent: priceDir.value === 'above' ? v : -v, basePrice: basePrice.value };
        }
        case 'daily': {
          const v = n(percent.value);
          if (!(v > 0 && v <= 100)) return fail('Enter a percentage between 0 and 100.');
          return { direction: dailyDir.value, percent: v };
        }
        case 'position': {
          if (!props.avgCost) return fail(`Add your ${props.symbol} position (quantity and average cost) first.`);
          const v = n(percent.value);
          if (!(v > 0)) return fail('Enter a percentage above 0.');
          return { direction: posDir.value, percent: v };
        }
        case 'high52':
        case 'low52': {
          const w = n(within.value);
          if (!(w >= 0 && w <= 50)) return fail('"Within" must be between 0 and 50%.');
          return { within: w };
        }
        case 'volume': {
          const m = n(multiple.value);
          if (!(m > 1 && m <= 100)) return fail('Enter a multiple above 1 (e.g. 2 for twice the average).');
          return { multiple: m };
        }
      }
      return fail('Choose an alert type.');
    }

    function submit() {
      localError.value = null;
      const params = buildParams();
      if (params) emit('save', { kind: kind.value, params, repeat: repeat.value, note: note.value.trim() });
    }

    onMounted(() => firstInput.value?.focus());

    return {
      ALERT_KINDS, kind, repeat, note, localError, firstInput, price,
      priceDir, priceMode, priceValue, dailyDir, posDir, percent, within, multiple,
      helper, submit, formatUSD,
    };
  },
  template: `
    <form class="alert-form" @submit.prevent="submit" @keydown.esc.stop="$emit('cancel')" @click.stop novalidate>
      <label class="alert-field">
        <span class="alert-field-label">Alert when</span>
        <select v-model="kind">
          <option v-for="k in ALERT_KINDS" :key="k.id" :value="k.id" :disabled="k.id === 'position' && !avgCost">
            {{ k.label }}{{ k.id === 'position' && !avgCost ? ' (needs a position)' : '' }}
          </option>
        </select>
      </label>

      <!-- Price target -->
      <div class="alert-row" v-if="kind === 'price'">
        <div class="range-btn-group alert-seg" role="group" aria-label="Direction">
          <button type="button" class="range-btn" :class="{ active: priceDir === 'above' }" @click="priceDir = 'above'">Above</button>
          <button type="button" class="range-btn" :class="{ active: priceDir === 'below' }" @click="priceDir = 'below'">Below</button>
        </div>
        <div class="alert-amount">
          <span class="alert-unit" v-if="priceMode === 'fixed'">$</span>
          <input ref="firstInput" type="number" inputmode="decimal" min="0" step="any" v-model="priceValue"
                 :aria-label="priceMode === 'fixed' ? 'Target price in dollars' : 'Percent from current price'" />
          <span class="alert-unit" v-if="priceMode === 'percent'">%</span>
        </div>
        <div class="range-btn-group alert-seg" role="group" aria-label="Value type">
          <button type="button" class="range-btn" :class="{ active: priceMode === 'fixed' }" title="A fixed price"
                  @click="priceMode = 'fixed'; priceValue = price ? String(Math.round(price * (priceDir === 'above' ? 1.05 : 0.95) * 100) / 100) : ''">$</button>
          <button type="button" class="range-btn" :class="{ active: priceMode === 'percent' }" title="Percent from the current price"
                  @click="priceMode = 'percent'; priceValue = '5'">%</button>
        </div>
      </div>

      <!-- Daily move -->
      <div class="alert-row" v-else-if="kind === 'daily'">
        <div class="range-btn-group alert-seg" role="group" aria-label="Direction">
          <button type="button" class="range-btn" :class="{ active: dailyDir === 'up' }" @click="dailyDir = 'up'">Up</button>
          <button type="button" class="range-btn" :class="{ active: dailyDir === 'down' }" @click="dailyDir = 'down'">Down</button>
          <button type="button" class="range-btn" :class="{ active: dailyDir === 'either' }" @click="dailyDir = 'either'">Either</button>
        </div>
        <div class="alert-amount">
          <input ref="firstInput" type="number" inputmode="decimal" min="0" step="any" v-model="percent" aria-label="Percent move" />
          <span class="alert-unit">% in a day</span>
        </div>
      </div>

      <!-- Position gain/loss -->
      <div class="alert-row" v-else-if="kind === 'position'">
        <div class="range-btn-group alert-seg" role="group" aria-label="Gain or loss">
          <button type="button" class="range-btn" :class="{ active: posDir === 'gain' }" @click="posDir = 'gain'">Gain</button>
          <button type="button" class="range-btn" :class="{ active: posDir === 'loss' }" @click="posDir = 'loss'">Loss</button>
        </div>
        <div class="alert-amount">
          <input ref="firstInput" type="number" inputmode="decimal" min="0" step="any" v-model="percent" aria-label="Percent gain or loss" />
          <span class="alert-unit">% vs. avg cost</span>
        </div>
      </div>

      <!-- 52-week high / low -->
      <div class="alert-row" v-else-if="kind === 'high52' || kind === 'low52'">
        <span class="alert-field-label">Within</span>
        <div class="alert-amount">
          <input ref="firstInput" type="number" inputmode="decimal" min="0" max="50" step="any" v-model="within" aria-label="Within percent" />
          <span class="alert-unit">% (0 = at a new {{ kind === 'high52' ? 'high' : 'low' }})</span>
        </div>
      </div>

      <!-- Volume spike -->
      <div class="alert-row" v-else-if="kind === 'volume'">
        <span class="alert-field-label">Volume</span>
        <div class="alert-amount">
          <input ref="firstInput" type="number" inputmode="decimal" min="1" step="any" v-model="multiple" aria-label="Volume multiple" />
          <span class="alert-unit">× the 3-month average</span>
        </div>
      </div>

      <div class="alert-helper" v-if="helper">{{ helper }}</div>

      <div class="alert-row">
        <span class="alert-field-label">Notify</span>
        <div class="range-btn-group alert-seg" role="group" aria-label="Repeat">
          <button type="button" class="range-btn" :class="{ active: repeat === 'once' }" @click="repeat = 'once'">Once</button>
          <button type="button" class="range-btn" :class="{ active: repeat === 'daily' }" @click="repeat = 'daily'">Every day</button>
        </div>
      </div>

      <input class="alert-note" v-model="note" maxlength="500" placeholder="Note (optional) — e.g. trim position, check margins" aria-label="Note" />

      <div class="notice error alert-error" v-if="localError || error">{{ localError || error }}</div>
      <div class="alert-actions">
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Saving…' : submitLabel }}</button>
        <button type="button" @click="$emit('cancel')">Cancel</button>
      </div>
    </form>
  `,
};
