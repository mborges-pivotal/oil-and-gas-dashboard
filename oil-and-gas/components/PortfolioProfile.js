const { ref, reactive, computed, watch, onMounted, onUnmounted } = Vue;
import PortfolioOverview from './PortfolioOverview.js';
import TopMovers from './TopMovers.js';
import { fetchQuote, fetchChart, fetchSector } from '../services/yahooFinance.js';
import { fetchPortfolioProfile, setFollowing, shareLink, copyText } from '../services/social.js';
import { formatPct, changeClass } from '../utils/formatters.js';
import { CATEGORIES, CATEGORY_LABELS, CATEGORY_SHORT, autoCategory, buildSlices, assignSlots, shortSector } from '../utils/allocation.js';

const categoryOrder = CATEGORIES.map(c => c.id);

/**
 * A public portfolio's profile (Leaderboard → a portfolio; or a forwarded
 * #portfolio=<id> link) — open to everyone, signed in or not. Percentages
 * only, never dollar amounts: the server sends its holdings and trades scaled
 * to a cost of 100 (server/social.js), and this shows
 *  - Performance: the all-time gain chart (1D · 1W · 1M · YTD · 1Y · All-Time),
 *  - Holdings: each holding's weight (%),
 *  - Sectors: the by-sector donut (%),
 *  - Top movers among its holdings today,
 * with Follow (signed in) and Forward (copy a link).
 */
export default {
  name: 'PortfolioProfile',
  components: { PortfolioOverview, TopMovers },
  props: { id: { type: String, required: true }, refreshSeconds: { type: Number, default: 60 } },
  emits: ['back', 'sign-in'],
  setup(props) {
    const data = ref(null);   // { portfolio, positions }
    const error = ref(null);
    const quotes = reactive({});
    const intraday = reactive({});
    const sectors = reactive({}); // symbol → sector | null
    const toast = ref(null);
    const busy = ref(false);

    const symbols = computed(() => Object.keys(data.value?.positions ?? {}));

    async function loadQuotes() {
      await Promise.all(symbols.value.map(async sym => {
        try {
          const q = await fetchQuote(sym);
          quotes[sym] = q;
          fetchChart(sym, '1d', '5m').then(chart => {
            const series = [];
            chart.timestamps.forEach((ts, i) => {
              if (chart.closes[i] != null) series.push({ period: new Date(ts * 1000).toISOString(), value: chart.closes[i] });
            });
            intraday[sym] = { series, previousClose: q.previousClose, error: null };
          }).catch(() => { if (!intraday[sym]) intraday[sym] = { series: [], previousClose: null, error: 'unavailable' }; });
        } catch { if (!quotes[sym]) quotes[sym] = { price: null, error: true }; }
        if (!(sym in sectors)) fetchSector(sym).then(i => { sectors[sym] = i?.sector ?? null; }).catch(() => { sectors[sym] = null; });
      }));
    }
    async function load() {
      error.value = null;
      try {
        data.value = await fetchPortfolioProfile(props.id);
        await loadQuotes();
      } catch (e) {
        error.value = e.message === 'Portfolio not found' ? "This portfolio isn't public (or no longer exists)." : e.message;
      }
    }
    watch(() => props.id, () => { data.value = null; load(); });
    let timer = null;
    onMounted(() => {
      load();
      timer = setInterval(loadQuotes, Math.max(30, props.refreshSeconds) * 1000);
    });
    onUnmounted(() => clearInterval(timer));

    const categoryOf = sym => data.value?.positions[sym]?.category || (quotes[sym]?.instrumentType ? autoCategory(quotes[sym].instrumentType) : null);
    const isCash = sym => categoryOf(sym) === 'cash';
    // For the chart: shaped like a portfolio ({ portfolio: { SYM: position } }).
    const chartPortfolio = computed(() => ({ portfolio: data.value?.positions ?? {} }));

    // Each holding's (scaled) value — only ever shown as a share of the total.
    const rows = computed(() => {
      const out = [];
      for (const [sym, p] of Object.entries(data.value?.positions ?? {})) {
        const q = quotes[sym];
        if (!q) return null; // still loading
        const price = q.price ?? (isCash(sym) ? 1 : null);
        if (price == null) continue;
        out.push({ symbol: sym, name: q.shortName ?? '', value: p.quantity * price, category: categoryOf(sym) });
      }
      return out;
    });
    const holdings = computed(() => rows.value?.map(({ symbol, name, value }) => ({ symbol, name, value })) ?? null);
    const sectorSlices = computed(() => {
      const r = rows.value;
      if (!r || r.some(x => !x.category) || r.some(x => x.category === 'stocks' && !(x.symbol in sectors))) return null;
      const items = r.filter(x => x.value > 0).map(x => {
        if (x.category !== 'stocks') return { key: x.category, label: CATEGORY_LABELS[x.category], short: CATEGORY_SHORT[x.category], value: x.value, symbol: x.symbol };
        const s = sectors[x.symbol];
        return s ? { key: 'sector:' + s, label: s, short: shortSector(s), value: x.value, symbol: x.symbol }
          : { key: 'sector:?', label: 'Unclassified stocks', short: 'Unclassified', value: x.value, symbol: x.symbol };
      });
      const keys = [...new Set(items.filter(i => i.key.startsWith('sector:') && i.key !== 'sector:?').map(i => i.key))].sort();
      return assignSlots(buildSlices(items, [...keys, 'sector:?', ...categoryOrder]));
    });
    const moverSources = computed(() => [{ id: 'holdings', label: 'Holdings', symbols: symbols.value.filter(s => !isCash(s)) }]);

    function flash(m) {
      toast.value = m;
      setTimeout(() => { if (toast.value === m) toast.value = null; }, 2200);
    }
    async function toggleFollow() {
      const p = data.value.portfolio;
      busy.value = true;
      try {
        const r = await setFollowing(p.id, !p.following);
        p.following = r.following;
        p.followers = r.followers;
        if (r.following) flash(`Following @${p.id} — its new updates appear in My Account → ✉ → Activity`);
      } catch (e) { flash(e.message); }
      busy.value = false;
    }
    async function forward() {
      if (await copyText(shareLink(`portfolio=${props.id}`))) flash('Link copied — paste it anywhere to share this portfolio');
    }
    const initials = name => (name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

    return { data, error, quotes, intraday, chartPortfolio, holdings, sectorSlices, moverSources, isCash, toast, busy, toggleFollow, forward, initials, load, formatPct, changeClass };
  },
  template: `
    <div class="pf-profile">
      <button type="button" class="link-button pf-profile-back" @click="$emit('back')">← Leaderboard</button>
      <div class="toast" v-if="toast" role="status">{{ toast }}</div>
      <div class="notice error" v-if="error">{{ error }} <button type="button" class="link-button" @click="load">Retry</button></div>
      <div class="skeleton" style="height:220px;margin-top:12px" v-else-if="!data"></div>
      <template v-else>
        <header class="pf-profile-head">
          <span class="pf-thumb pf-thumb-lg" aria-hidden="true"><img v-if="data.portfolio.image" :src="data.portfolio.image" alt="" /><template v-else>{{ initials(data.portfolio.name) }}</template></span>
          <div class="pf-profile-who">
            <h3 class="pf-profile-name">{{ data.portfolio.name }}</h3>
            <div class="text-sm"><span class="post-handle">@{{ data.portfolio.id }}</span> <span class="text-muted">· {{ data.portfolio.owner }} · {{ data.portfolio.followers }} follower{{ data.portfolio.followers === 1 ? '' : 's' }}</span></div>
          </div>
          <div class="pf-profile-return">
            <span class="pf-card-label">All-time</span>
            <strong :class="changeClass(data.portfolio.returnPct)">{{ data.portfolio.returnPct != null ? formatPct(data.portfolio.returnPct) : '—' }}</strong>
          </div>
          <div class="pf-profile-actions">
            <span class="text-muted text-sm" v-if="data.portfolio.mine">Yours</span>
            <button v-else-if="data.portfolio.signedIn" type="button" :class="data.portfolio.following ? 'following-btn' : 'primary'" :disabled="busy"
                    :aria-pressed="data.portfolio.following" @click="toggleFollow">{{ data.portfolio.following ? '✓ Following' : '＋ Follow' }}</button>
            <button v-else type="button" class="primary" @click="$emit('sign-in')" title="Sign in to follow this portfolio">＋ Follow</button>
            <button type="button" class="post-btn" title="Copy a link to this portfolio" @click="forward"><span aria-hidden="true">↗</span> Forward</button>
          </div>
        </header>

        <p class="text-muted text-sm" v-if="!Object.keys(data.positions).length">This portfolio has no holdings right now.</p>
        <template v-else>
          <PortfolioOverview pct-only :portfolio="chartPortfolio" :intraday="intraday" :quotes="quotes" :is-cash="isCash"
                             :holdings="holdings" :sectors="sectorSlices" storage-key="oilgas_profile_overview" />
          <TopMovers :sources="moverSources" :selected-ids="['holdings']" :quotes="quotes" />
        </template>
        <p class="text-muted text-sm pf-profile-note">
          Percentages only — no amounts, share counts or option positions are shared. Holdings weigh each stock, fund or cash holding by today's market value;
          the gain chart is rebuilt from its trades and daily closes (cash and options aren't charted).
        </p>
      </template>
    </div>
  `,
};
