const { ref, computed, onMounted, watch } = Vue;
import { ALERT_KINDS, OPTION_ALERT_KINDS } from '../utils/alerts.js';
import { daysToExpiry, moneyness } from '../utils/options.js';
import { formatPrice } from '../utils/formatters.js';

/**
 * Create / edit one stock alert (stock card → 🔔 tab). `initial` is an
 * existing alert or a preset ({ kind, params, repeat?, note? }); `quote` is
 * the stock's current quote (price, 52-week range) and `avgCost` its
 * Portfolio average cost, if held — both used for prefills and the live
 * "= 172.21" helpers. For an option contract, `option` ({ type, strike,
 * expiry, underlying, short }) switches to the contract's alert types —
 * premium target / move / gain-loss, days to expiration, in/out of the
 * money (helpers use `underlyingPrice`). A short option gains as its
 * premium falls. Emits save({ kind, params, repeat, note }) and cancel.
 */
export default {
  name: 'AlertForm',
  props: {
    symbol: String,
    quote: Object,
    avgCost: { type: Number, default: null },
    initial: { type: Object, default: () => ({ kind: 'price', params: { direction: 'above', basis: 'percent', percent: 5 } }) },
    // multi: the same alert for several stocks (Inbox → Alerts) — no single
    // quote or position to work from; % price targets use each stock's own
    // current price (the server fills it in), gain/loss applies to held ones.
    multi: Boolean,
    option: { type: Object, default: null },
    earnings: { type: Object, default: null }, // the stock's next earnings date, for the helper
    underlyingPrice: { type: Number, default: null },
    submitLabel: { type: String, default: 'Save alert' },
    busy: Boolean,
    error: String,
  },
  emits: ['save', 'cancel', 'kind-change'],
  setup(props, { emit }) {
    const p0 = props.initial.params ?? {};
    const kind = ref(props.initial.kind ?? 'price');
    const repeat = ref(props.initial.repeat ?? 'once');
    const note = ref(props.initial.note ?? '');
    const localError = ref(null);
    const firstInput = ref(null);

    const price = computed(() => props.quote?.price ?? null);

    // Price target: direction + either a fixed price or a % from a base price.
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
    const days = ref(String(p0.days ?? 7));
    const strikeState = ref(p0.state === 'otm' ? 'otm' : 'itm');
    const kinds = computed(() => (props.option ? OPTION_ALERT_KINDS : ALERT_KINDS));
    const short = computed(() => !!props.option?.short);

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
          if (priceMode.value === 'percent' && !basePrice.value) {
            const v = n(priceValue.value);
            if (!Number.isFinite(v)) return '';
            return `${priceDir.value === 'above' ? '+' : '−'}${v}% from ${props.multi ? "each stock's" : 'the'} current price (set when you save)`;
          }
          if (priceMode.value === 'fixed' && props.multi) return 'The same target price for every selected stock — use % to scale it to each one.';
          if (priceTarget.value == null) return '';
          if (priceMode.value === 'percent') return `= ${formatPrice(priceTarget.value)} (from ${formatPrice(basePrice.value)})`;
          if (!price.value) return '';
          const d = ((priceTarget.value - price.value) / price.value) * 100;
          return `${d >= 0 ? '+' : ''}${d.toFixed(1)}% from the current ${formatPrice(price.value)}`;
        }
        case 'position': {
          if (props.multi) return "Applies to the selected stocks you hold, vs. each one's average cost — the rest are skipped.";
          if (!props.avgCost) return '';
          const v = n(percent.value);
          if (!Number.isFinite(v)) return '';
          // A short option gains as the premium falls.
          const up = (posDir.value === 'gain') !== short.value;
          const at = props.avgCost * (1 + (up ? v : -v) / 100);
          if (props.option) return `Triggers at a premium of ${formatPrice(at)} (you ${short.value ? 'sold' : 'paid'} ${formatPrice(props.avgCost)} on average)`;
          return `Triggers at ${formatPrice(at)} (your average cost is ${formatPrice(props.avgCost)})`;
        }
        case 'earnings': {
          const e = props.earnings;
          if (props.multi) return "Uses each stock's next earnings date (Nasdaq / Zacks).";
          if (!e?.date) return 'No upcoming earnings date found yet — the alert fires once one is known.';
          const left = daysToExpiry(e.date);
          return `Next earnings ${e.date} (${left} day${left === 1 ? '' : 's'} away)${e.confirmed ? '' : ' — estimated date'}`;
        }
        case 'expiry': {
          const left = daysToExpiry(props.option.expiry);
          return left >= 0 ? `Expires ${props.option.expiry} — ${left} day${left === 1 ? '' : 's'} from today` : 'This contract has expired.';
        }
        case 'strike': {
          const m = moneyness(props.option, props.underlyingPrice);
          if (!m) return `Strike ${formatPrice(props.option.strike)}`;
          return `${props.option.underlying} is ${formatPrice(props.underlyingPrice)} vs. the ${formatPrice(props.option.strike)} strike — `
            + (m === 'itm' ? 'in the money now' : m === 'otm' ? 'out of the money now' : 'at the money now');
        }
        case 'high52':
        case 'low52': {
          const ref52 = kind.value === 'high52' ? props.quote?.fiftyTwoWeekHigh : props.quote?.fiftyTwoWeekLow;
          if (!ref52) return '';
          const w = n(within.value) || 0;
          const at = kind.value === 'high52' ? ref52 * (1 - w / 100) : ref52 * (1 + w / 100);
          return `52-week ${kind.value === 'high52' ? 'high' : 'low'} is ${formatPrice(ref52)}`
            + (w ? ` — triggers ${kind.value === 'high52' ? 'at or above' : 'at or below'} ${formatPrice(at)}` : '');
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
          if (priceDir.value === 'below' && v >= 100) return fail('A drop must be less than 100%.');
          const out = { direction: priceDir.value, basis: 'percent', percent: priceDir.value === 'above' ? v : -v };
          // Without a known price (Inbox, or quote still loading) the server uses the current one.
          if (basePrice.value) out.basePrice = basePrice.value;
          return out;
        }
        case 'daily': {
          const v = n(percent.value);
          if (!(v > 0 && v <= 100)) return fail('Enter a percentage between 0 and 100.');
          return { direction: dailyDir.value, percent: v };
        }
        case 'position': {
          if (!props.avgCost && !props.multi) return fail(props.option ? 'Add this option to your Portfolio first.' : `Add your ${props.symbol} position (quantity and average cost) first.`);
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
        case 'earnings':
        case 'expiry': {
          const d = n(days.value);
          if (!(Number.isInteger(d) && d >= 0 && d <= 365)) return fail('Enter a whole number of days, 0 to 365.');
          return { days: d };
        }
        case 'strike':
          return { state: strikeState.value };
      }
      return fail('Choose an alert type.');
    }

    function submit() {
      localError.value = null;
      const params = buildParams();
      if (params) emit('save', { kind: kind.value, params, repeat: repeat.value, note: note.value.trim() });
    }

    // Switching type swaps in that type's usual threshold, unless you've
    // typed your own (daily moves start at 3%, position gain/loss at 20%).
    const DEFAULT_PERCENT = { daily: '3', position: '20' };
    watch(kind, (k, prev) => {
      emit('kind-change', k);
      if (k in DEFAULT_PERCENT && (!(prev in DEFAULT_PERCENT) ? percent.value === DEFAULT_PERCENT.daily || percent.value === DEFAULT_PERCENT.position : percent.value === DEFAULT_PERCENT[prev])) {
        percent.value = DEFAULT_PERCENT[k];
      }
    }, { immediate: true });
    // Under the Inbox stock picker, focus stays with the picker.
    onMounted(() => { if (!props.multi) firstInput.value?.focus(); });

    return {
      kinds, short, days, strikeState, kind, repeat, note, localError, firstInput, price,
      priceDir, priceMode, priceValue, dailyDir, posDir, percent, within, multiple,
      helper, submit, formatPrice,
    };
  },
  template: `
    <form class="alert-form" @submit.prevent="submit" @keydown.esc.stop="$emit('cancel')" @click.stop novalidate>
      <label class="alert-field">
        <span class="alert-field-label">Alert when</span>
        <select v-model="kind">
          <option v-for="k in kinds" :key="k.id" :value="k.id" :disabled="k.id === 'position' && !avgCost && !multi">
            {{ k.label }}{{ k.id === 'position' && !avgCost && !multi ? ' (needs a position)' : '' }}
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
          <input ref="firstInput" type="number" inputmode="decimal" min="0" step="any" v-model="priceValue"
                 :aria-label="priceMode === 'fixed' ? (option ? 'Target premium' : 'Target price') : 'Percent from current price'" />
          <span class="alert-unit" v-if="priceMode === 'percent'">%</span>
        </div>
        <div class="range-btn-group alert-seg" role="group" aria-label="Value type">
          <button type="button" class="range-btn" :class="{ active: priceMode === 'fixed' }" title="A fixed price"
                  @click="priceMode = 'fixed'; priceValue = price ? String(Math.round(price * (priceDir === 'above' ? 1.05 : 0.95) * 100) / 100) : ''">Price</button>
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
          <span class="alert-unit">% vs. {{ option ? 'avg premium' : 'avg cost' }}</span>
        </div>
      </div>

      <!-- Earnings coming up -->
      <div class="alert-row" v-else-if="kind === 'earnings'">
        <div class="alert-amount">
          <input ref="firstInput" type="number" inputmode="numeric" min="0" max="365" step="1" v-model="days" aria-label="Days before earnings" />
          <span class="alert-unit">days or less before earnings</span>
        </div>
      </div>

      <!-- Option: days to expiration -->
      <div class="alert-row" v-else-if="kind === 'expiry'">
        <div class="alert-amount">
          <input ref="firstInput" type="number" inputmode="numeric" min="0" max="365" step="1" v-model="days" aria-label="Days to expiration" />
          <span class="alert-unit">days or less to expiration</span>
        </div>
      </div>

      <!-- Option: underlying in / out of the money -->
      <div class="alert-row" v-else-if="kind === 'strike'">
        <div class="range-btn-group alert-seg" role="group" aria-label="Money state">
          <button type="button" class="range-btn" :class="{ active: strikeState === 'itm' }" @click="strikeState = 'itm'">In the money</button>
          <button type="button" class="range-btn" :class="{ active: strikeState === 'otm' }" @click="strikeState = 'otm'">Out of the money</button>
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
