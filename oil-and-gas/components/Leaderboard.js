const { ref, watch, onMounted } = Vue;
import { formatPct, formatDate } from '../utils/formatters.js';
import PortfolioProfile from './PortfolioProfile.js';

/**
 * Leaderboard (the subheader's last tab; open to everyone): public portfolios (any account) ranked by return
 * for a period — Today, 1W, 1M, 3M, YTD, 1Y, All-Time (server/leaderboard.js).
 * Each row: rank, movement since the previous trading day's standings (▲ up
 * in green, ▼ down in red, NEW), the portfolio's picture (its initials when
 * it has none), the portfolio and profile names, and the return. Your own rows are highlighted.
 * Click a row for the portfolio's profile (PortfolioProfile — percentages only),
 * shown here in place of the list (v-model:profile = its ID).
 */
const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: '1w', label: '1W' },
  { id: '1m', label: '1M' },
  { id: '3m', label: '3M' },
  { id: 'ytd', label: 'YTD' },
  { id: '1y', label: '1Y' },
  { id: 'all', label: 'All-Time' },
];
const KEY = 'oilgas_leaderboard_period';

export default {
  name: 'Leaderboard',
  props: { publicCount: { type: Number, default: 0 }, signedIn: Boolean, profile: { type: String, default: null }, refreshSeconds: Number },
  emits: ['make-public', 'update:profile', 'sign-in'],
  components: { PortfolioProfile },
  setup(props) {
    const period = ref((() => {
      try { const v = localStorage.getItem(KEY); if (PERIODS.some(p => p.id === v)) return v; } catch { /* none */ }
      return 'all';
    })());
    const board = ref(null);
    const loading = ref(false);
    const error = ref(null);
    let seq = 0;
    async function load() {
      const mine = ++seq;
      loading.value = true;
      error.value = null;
      try {
        const res = await fetch(`/api/leaderboard?period=${period.value}`, { credentials: 'same-origin' });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        if (mine === seq) board.value = body;
      } catch (e) {
        if (mine === seq) error.value = e.message;
      } finally {
        if (mine === seq) loading.value = false;
      }
    }
    watch(period, p => { try { localStorage.setItem(KEY, p); } catch { /* per-browser only */ } load(); });
    onMounted(() => { if (!props.profile) load(); });
    // Back from a profile: the list (loaded now if it wasn't).
    watch(() => props.profile, id => { if (!id && !board.value) load(); });
    const periodLabel = id => PERIODS.find(p => p.id === id)?.label ?? id;
    return { PERIODS, period, board, loading, error, load, periodLabel, formatPct, formatDate };
  },
  template: `
    <div>
    <PortfolioProfile v-if="profile" :id="profile" :refresh-seconds="refreshSeconds"
                      @back="$emit('update:profile', null)" @sign-in="$emit('sign-in')" />
    <template v-else>
    <div class="section-header mb-16">Leaderboard</div>
    <div class="card leaderboard-card">
      <div class="lb-head">
        <div>
          <div class="text-muted text-sm">Public portfolios ranked by return<template v-if="board?.asOf"> · as of {{ formatDate(board.asOf + 'T12:00:00') }} close</template></div>
        </div>
        <div class="range-btn-group lb-periods" role="group" aria-label="Period">
          <button v-for="p in PERIODS" :key="p.id" type="button" class="range-btn" :class="{ active: period === p.id }"
                  :aria-pressed="period === p.id" @click="period = p.id">{{ p.label }}</button>
        </div>
      </div>

      <p class="notice lb-join" v-if="signedIn && !publicCount">
        None of your portfolios is public. Make one public under <a href="#" @click.prevent="$emit('make-public')">Account → Portfolios</a> (open it → Edit) to join the leaderboard.
      </p>

      <div class="notice error" v-if="error">Couldn't load the leaderboard: {{ error }} <button type="button" class="link-button" @click="load">Retry</button></div>
      <div class="skeleton" style="height:200px;margin-top:12px" v-else-if="loading && !board"></div>
      <p class="text-muted text-sm" style="margin:14px 0 0" v-else-if="board && !board.rows.length">
        No public portfolios with a {{ periodLabel(period) }} return yet.
      </p>
      <ol class="lb-list" v-else-if="board" :class="{ busy: loading }">
        <li v-for="r in board.rows" :key="r.rank + r.portfolio + r.owner" class="lb-row" :class="{ mine: r.mine, podium: r.rank <= 3, linked: r.portfolioId }"
            :tabindex="r.portfolioId ? 0 : null" :role="r.portfolioId ? 'link' : null" :aria-label="r.portfolioId ? r.portfolio + ' by ' + r.owner + ', ' + formatPct(r.returnPct) + ' — open its profile' : null"
            @click="r.portfolioId && $emit('update:profile', r.portfolioId)" @keydown.enter="r.portfolioId && $emit('update:profile', r.portfolioId)">
          <span class="lb-rank">{{ r.rank }}</span>
          <span class="lb-move" :class="r.movement > 0 ? 'up' : r.movement < 0 ? 'down' : r.movement === null ? 'new' : 'same'"
                :title="r.movement === null ? 'New since the previous trading day' : r.movement === 0 ? 'No change since the previous trading day' : (r.movement > 0 ? 'Up ' : 'Down ') + Math.abs(r.movement) + ' since the previous trading day'">
            <template v-if="r.movement > 0">▲ {{ r.movement }}</template>
            <template v-else-if="r.movement < 0">▼ {{ -r.movement }}</template>
            <template v-else-if="r.movement === null">NEW</template>
            <template v-else>–</template>
          </span>
          <span class="pf-thumb lb-thumb" aria-hidden="true"><img v-if="r.image" :src="r.image" alt="" /><template v-else>{{ r.initials }}</template></span>
          <span class="lb-names">
            <span class="lb-portfolio">{{ r.portfolio }}<span class="lb-you" v-if="r.mine">You</span></span>
            <span class="lb-owner text-muted">{{ r.owner }}</span>
          </span>
          <span class="lb-return" :class="r.returnPct > 0 ? 'positive' : r.returnPct < 0 ? 'negative' : ''">{{ formatPct(r.returnPct) }}</span>
        </li>
      </ol>
      <p class="text-muted text-sm lb-note">
        Returns on stocks and funds (cash and options left out), adjusted for money added or taken out; All-Time is the gain over cost of what's held.
        Arrows show movement since the previous trading day. Click a portfolio for its profile — performance, holdings and sectors as percentages, never amounts.
      </p>
    </div>
    </template>
    </div>
  `,
};
