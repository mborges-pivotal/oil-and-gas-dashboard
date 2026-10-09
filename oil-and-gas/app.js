import { loadConfig, saveConfig, adoptServerIds } from './utils/config.js';
import { emptyPortfolio } from './utils/portfolios.js';
import { configureYahooFinance } from './services/yahooFinance.js';
import { fetchCurrentUser, logout } from './services/auth.js';
import { THEME_OPTIONS, applyTheme, normalizeTheme } from './utils/theme.js';

// Lazy-loaded components — imported as strings for Vue CDN defineAsyncComponent pattern
import MarketsComponent, { SECTIONS as MARKET_SECTIONS } from './components/Markets.js';
import StocksComponent from './components/Stocks.js';
import Leaderboard from './components/Leaderboard.js';
import InboxComponent from './components/Inbox.js';
import { loadNotes, clearNotes } from './utils/notesStore.js';
import { unreadTotal, defaultInboxSection, clearInbox, onMarkRead, refreshActivity } from './utils/inboxStore.js';
import { loadAlerts, clearAlerts, checkNow, persistAlertsRead } from './utils/alertsStore.js';
import AccountComponent from './components/Account.js';
import ArticleViewer from './components/ArticleViewer.js';
import UserMenu from './components/UserMenu.js';

const { createApp, ref, reactive, computed, provide, onMounted, watch, nextTick } = Vue;

// ── Root App ────────────────────────────────────────────────────────────────
const App = {
  components: {
    Markets: MarketsComponent,
    Stocks: StocksComponent,
    Leaderboard,
    Inbox: InboxComponent,
    Account: AccountComponent,
    ArticleViewer,
    UserMenu,
  },
  setup() {
    const config = ref(null);
    // Signed-in user's profile (services/auth.js), or null when anonymous.
    const user = ref(null);
    const activeTab = ref('markets');
    const configLoaded = ref(false);
    const saveNotice = ref(null); // message string while shown
    const saveError = ref(null);

    // Content tabs only — Markets is the home page (the logo goes there), and
    // Settings and Sign In / Profile are pages reached from the header's account menu (UserMenu).
    // Account (your portfolios) appears when signed in — positions need an
    // account, and that's where portfolios are created.
    const hasPositions = computed(() => !!user.value);
    const tabs = computed(() => [
      // Inbox (signed in; next to the profile): Notes · Alerts · Activity, badged with unread alerts + activity.
      ...(user.value ? [{ id: 'inbox', label: 'Inbox', badge: unreadTotal() }] : []),
    ]);

    // Inbox (header, next to the profile): Notes · Alerts · Activity. Opening it
    // lands on unread alerts, then new activity, else Notes; links (a saved
    // news item, a forwarded update…) open it on a given section instead.
    const inboxSection = ref('notes');
    const accountStartTab = ref(null); // Account sub-tab to open on (links from other pages)
    // Open My Account on one of its tabs (even if it's already showing another).
    function goAccountTab(tab) {
      accountStartTab.value = null;
      activeTab.value = 'portfolio';
      nextTick(() => { accountStartTab.value = tab; });
    }
    function openInbox(section) {
      inboxSection.value = section;
      activeTab.value = 'inbox';
    }
    // Social: a forwarded update (#post=<id>) on top of Inbox → Activity; a
    // forwarded portfolio (#portfolio=<id>) searched in Account → Portfolios → Discover;
    // Inbox → Activity → Share update opens Account → Transactions in share mode.
    const focusPost = ref(null);
    const discoverQuery = ref(null);
    const startShare = ref(false);
    function openActivity(tab) {
      if (tab) try { localStorage.setItem('oilgas_activity_tab', tab); } catch { /* per-browser only */ }
      openInbox('messages');
    }
    function openDiscover(q = null) {
      discoverQuery.value = q;
      goAccountTab('portfolios');
    }
    function openShare() {
      startShare.value = true;
      goAccountTab('activity');
      setTimeout(() => { startShare.value = false; }); // once: later visits to Transactions open normally
    }
    // A forwarded portfolio opens its public profile (no account needed); an
    // update needs one — handled now if signed in, else right after signing in.
    function openLinkFromHash() {
      const m = /^#(post|portfolio)=([A-Za-z0-9-]{1,40})$/.exec(location.hash);
      if (!m || (m[1] === 'post' && !user.value)) return;
      history.replaceState(null, '', location.pathname + location.search);
      if (m[1] === 'post') {
        focusPost.value = Number(m[2]) || null;
        openActivity();
      } else {
        openProfile(m[2]);
      }
    }
    // Leaderboard (open to everyone): the list, or one portfolio's profile.
    const leaderboardProfile = ref(null);
    function openProfile(id) {
      leaderboardProfile.value = id;
      activeTab.value = 'leaderboard';
      window.scrollTo({ top: 0 });
    }
    function openSignIn() {
      accountSection.value = 'profile';
      activeTab.value = 'account';
    }
    window.addEventListener('hashchange', openLinkFromHash);

    // The subheader (frozen under the header, on every page): My Account,
    // then Markets' sections. My Account opens Account signed in, else the sign-in page.
    const marketsSection = ref('markets');
    const marketsUpdated = ref(null); // Markets' last refresh time, shown in the subheader
    const subTabs = computed(() => [
      { id: 'my-account', label: 'My Account', short: 'Account' },
      ...MARKET_SECTIONS,
      { id: 'leaderboard', label: 'Leaderboard', short: '🏆' }, // phones: just the trophy
    ]);
    function selectSubTab(id) {
      if (id === 'leaderboard') {
        leaderboardProfile.value = null; // the list
        selectTab('leaderboard');
        return;
      }
      if (id === 'my-account') {
        if (user.value) selectTab('portfolio');
        else { accountSection.value = 'profile'; selectTab('account'); }
        return;
      }
      marketsSection.value = id;
      if (activeTab.value !== 'markets') selectTab('markets');
    }
    const subTabActive = id => (id === 'my-account'
      ? activeTab.value === 'portfolio' || (!user.value && activeTab.value === 'account')
      : id === 'leaderboard' ? activeTab.value === 'leaderboard'
      : activeTab.value === 'markets' && marketsSection.value === id);
    // On a phone the row can scroll sideways — keep the active one visible.
    const subtabBar = ref(null);
    watch([activeTab, marketsSection], () => nextTick(() => {
      subtabBar.value?.querySelector('.subtab-btn.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }));

    // The logo (icon + name): back to the home page, Markets → Markets.
    function goHome() {
      marketsSection.value = 'markets';
      selectTab('markets');
      window.scrollTo({ top: 0 });
    }
    function selectTab(id) {
      accountStartTab.value = null; // Account opens on its last-used sub-tab
      discoverQuery.value = null;
      focusPost.value = null;
      if (id === 'inbox' && activeTab.value !== 'inbox') inboxSection.value = defaultInboxSection();
      activeTab.value = id;
    }
    // Account page section (Profile / Labels / Alerts); "Manage labels" in
    // Notes opens Labels, "Manage alerts" in Inbox → Alerts opens Alerts.
    const accountSection = ref('profile');
    function openLabels() {
      accountSection.value = 'labels';
      activeTab.value = 'account';
    }
    function openAlertsManager() {
      accountSection.value = 'alerts';
      activeTab.value = 'account';
    }

    function openNotes() {
      openInbox('notes');
    }
    // Notes and alerts are per account (DB): load on sign-in, drop on sign-out.
    // Alerts are evaluated by the server whenever quotes refresh — on load
    // and then every refresh interval — while someone is signed in.
    onMarkRead('alerts', persistAlertsRead);
    let alertTimer = null;
    function startAlertChecks() {
      clearInterval(alertTimer);
      const interval = Math.max(30, config.value?.ui?.refreshIntervalSeconds ?? 60) * 1000;
      alertTimer = setInterval(() => { checkNow(); refreshActivity(); }, interval);
    }
    watch(() => user.value?.id ?? null, async id => {
      clearInterval(alertTimer);
      if (id) {
        loadNotes();
        await loadAlerts();
        checkNow();
        refreshActivity();
        startAlertChecks();
        openLinkFromHash();
      } else {
        clearNotes();
        clearAlerts();
        clearInbox();
        if (activeTab.value === 'inbox') activeTab.value = 'markets';
        openLinkFromHash(); // a forwarded portfolio opens signed out too (an update waits for sign-in)
      }
    }, { immediate: true });
    // A changed refresh interval (Settings) re-times the checks.
    watch(() => config.value?.ui?.refreshIntervalSeconds, () => { if (user.value) startAlertChecks(); });
    // Signed out while on Account.
    watch(hasPositions, has => {
      if (!has && activeTab.value === 'portfolio') activeTab.value = 'markets';
    });

    function showNotice(message) {
      saveError.value = null;
      saveNotice.value = message;
      setTimeout(() => { if (saveNotice.value === message) saveNotice.value = null; }, 2500);
    }

    // Swaps in a freshly loaded config (after sign-in or sign-out).
    function applyConfig(cfg) {
      config.value = cfg;
      applyTheme(cfg.ui?.theme);
      configureYahooFinance(cfg.yahooFinance);
    }

    onMounted(async () => {
      user.value = await fetchCurrentUser();
      try {
        config.value = await loadConfig(user.value);
      } catch (err) {
        // Profile couldn't be read/seeded — fall back to this browser's
        // settings rather than leaving the whole dashboard on "Loading…".
        saveError.value = `Couldn't load your profile settings (${err.message}); showing this browser's settings.`;
        user.value = null;
        config.value = await loadConfig();
      }
      configureYahooFinance(config.value.yahooFinance);
      applyTheme(config.value.ui?.theme);
      configLoaded.value = true;
    });

    // Profile → Dashboard saved: only the fields it edits are merged into the
    // live settings, so everything else (watchlist, portfolios, theme, API keys)
    // stays as it is now.
    async function onSaveConfig(updated) {
      const next = {
        ...config.value,
        ui: { ...config.value.ui, ...updated.ui },
        yahooFinance: updated.yahooFinance,
        crackSpreadThresholds: updated.crackSpreadThresholds,
        news: updated.news,
      };
      try {
        await saveConfig(next, user.value);
      } catch (err) {
        saveError.value = `Settings were not saved: ${err.message}`;
        return;
      }
      config.value = next;
      configureYahooFinance(config.value.yahooFinance);
      showNotice(user.value ? '✓ Settings saved to your profile.' : '✓ Settings saved.');
    }

    // The profile menu: Profile / Sign in, or Dashboard settings (Profile → Dashboard).
    function onMenuNavigate(target) {
      accountSection.value = target === 'account:dashboard' ? 'dashboard' : 'profile';
      activeTab.value = 'account';
    }

    async function onSignedIn(signedInUser, { isNew } = {}) {
      user.value = signedInUser;
      try {
        applyConfig(await loadConfig(signedInUser));
        showNotice(isNew
          ? '✓ Account created — your current settings were saved to your profile.'
          : '✓ Signed in — loaded your saved settings.');
      } catch (err) {
        saveError.value = `Signed in, but couldn't load your profile settings: ${err.message}`;
      }
      // From the sign-in page, on to My Account (not the Profile page).
      if (activeTab.value === 'account') selectTab('portfolio');
    }

    async function onSignedOut() {
      user.value = null;
      applyConfig(await loadConfig());
      showNotice('✓ Signed out — using this browser\'s settings.');
    }

    // Sign out from the header menu (the Profile page has its own button).
    async function onMenuSignOut() {
      try {
        await logout();
      } finally {
        if (activeTab.value === 'account') activeTab.value = 'markets';
        await onSignedOut();
      }
    }

    function onUserUpdated(updatedUser) { user.value = updatedUser; }

    // Settings changed in place (outside the Settings panel) apply
    // immediately and save like any other setting — to the profile when
    // signed in, else this browser. `what` labels a failed save.
    async function persistConfig(next, what) {
      config.value = next;
      try {
        const saved = await saveConfig(next, user.value);
        // Portfolio IDs the server made unique replace ours.
        const adopted = saved && adoptServerIds(config.value, next, saved);
        if (adopted) config.value = adopted;
      } catch (err) {
        saveError.value = `${what} was applied but not saved: ${err.message}`;
      }
    }

    // Header light/dark/system switch
    const themePreference = computed(() => normalizeTheme(config.value?.ui?.theme));
    // The theme button: System → Dark → Light → System…
    const THEME_CYCLE = ['system', 'dark', 'light'];
    const themeOf = v => THEME_OPTIONS.find(o => o.value === v) ?? THEME_OPTIONS[0];
    const themeNow = computed(() => themeOf(themePreference.value));
    const themeNext = computed(() => themeOf(THEME_CYCLE[(THEME_CYCLE.indexOf(themePreference.value) + 1) % THEME_CYCLE.length]));
    function cycleTheme() { setTheme(themeNext.value.value); }
    function setTheme(theme) {
      if (theme === themePreference.value) return;
      applyTheme(theme);
      persistConfig({ ...config.value, ui: { ...config.value.ui, theme } }, 'Theme');
    }

    // Default stock watchlist changed on My Account → Watchlist (reordered, or a
    // stock added via search / removed in Edit mode). Additional watchlists
    // are saved to the DB by the Stocks component itself.
    function onSetTickers(tickers) {
      persistConfig({ ...config.value, stocks: { ...config.value.stocks, tickers } }, 'Watchlist');
    }

    // Positions saved or removed in one portfolio (config.portfolios[i], see
    // utils/portfolios.js): { portfolioId, symbol, position } or { updates:
    // { SYMBOL: position | null, … } } — several in one save (a purchase paid
    // from a cash holding changes both), so they can't land separately.
    // `options` updates its option contracts the same way (OCC → position |
    // null); `closed` replaces its closed positions. `newPortfolio` ({ id,
    // name }) creates the portfolio first — a purchase into a new portfolio.
    // `cashDelta` adds to (or takes from) the account's cash (config.accountCash)
    // — a purchase paid from it, or a sale deposited to it.
    function onSetPosition({ portfolioId, newPortfolio, symbol, position, updates, options, closed, cashDelta }) {
      const merge = (current, changes) => {
        const out = { ...(current ?? {}) };
        for (const [sym, pos] of Object.entries(changes)) {
          if (pos) out[sym] = pos;
          else delete out[sym];
        }
        return out;
      };
      let list = [...(config.value.portfolios ?? [])];
      if (newPortfolio && !list.some(p => p.id === newPortfolio.id)) list.push(emptyPortfolio(newPortfolio.name, newPortfolio.id));
      const i = list.findIndex(p => p.id === portfolioId);
      if (i === -1) {
        saveError.value = 'That portfolio no longer exists — nothing was saved.';
        return;
      }
      const pf = { ...list[i], portfolio: merge(list[i].portfolio, updates ?? (symbol ? { [symbol]: position } : {})) };
      if (options) pf.optionPositions = merge(list[i].optionPositions, options);
      if (closed) pf.closedPositions = closed;
      list[i] = pf;
      const next = { ...config.value, portfolios: list };
      if (cashDelta) {
        const cash = config.value.accountCash ?? { balance: 0, deposits: [] };
        next.accountCash = { ...cash, balance: Math.round(((cash.balance ?? 0) + cashDelta) * 100) / 100 };
      }
      persistConfig(next, 'Portfolio position');
    }

    // The account's cash: a deposit added or deleted (Account → Summary).
    function onSetAccountCash(accountCash) {
      persistConfig({ ...config.value, accountCash }, 'Cash');
    }
    function openBankAccounts() {
      accountSection.value = 'banks';
      activeTab.value = 'account';
    }

    // A position moved between portfolios — every portfolio's change in one
    // save, plus its entry in config.transfers (Account → Transactions). Undo sends
    // the "before" state with removeTransferId (and removePortfolioId when the
    // move had created that portfolio).
    function onMovePosition({ changes, transfer, removeTransferId, removePortfolioId }) {
      const merge = (current, changes) => {
        const out = { ...(current ?? {}) };
        for (const [sym, pos] of Object.entries(changes ?? {})) {
          if (pos) out[sym] = pos;
          else delete out[sym];
        }
        return out;
      };
      let list = [...(config.value.portfolios ?? [])];
      for (const c of changes) {
        if (c.newPortfolio && !list.some(p => p.id === c.newPortfolio.id)) list.push(emptyPortfolio(c.newPortfolio.name, c.newPortfolio.id));
        const i = list.findIndex(p => p.id === c.portfolioId);
        if (i === -1) continue;
        list[i] = { ...list[i], portfolio: merge(list[i].portfolio, c.updates), optionPositions: merge(list[i].optionPositions, c.options) };
      }
      if (removePortfolioId) list = list.filter(p => p.id !== removePortfolioId);
      let transfers = config.value.transfers ?? [];
      if (removeTransferId) transfers = transfers.filter(t => t.id !== removeTransferId);
      if (transfer) transfers = [transfer, ...transfers];
      persistConfig({ ...config.value, portfolios: list, transfers }, 'Move');
    }

    // Leaderboard → "make one public": Account opened on its Portfolios sub-tab.
    function openAccountPortfolios() {
      goAccountTab('portfolios');
    }
    const publicPortfolios = computed(() => (config.value?.portfolios ?? []).filter(p => p.visibility === 'public').length);

    // Portfolios created, renamed or deleted (Account → Portfolios).
    function onSetPortfolios(list) {
      persistConfig({ ...config.value, portfolios: list }, 'Portfolios');
    }


    // Provide config to all child components
    provide('config', config);

    return {
      config, user, configLoaded, activeTab, tabs, saveNotice, saveError,
      inboxSection, selectTab, goHome, openNotes, marketsSection, marketsUpdated, subTabs, selectSubTab, subTabActive, subtabBar, focusPost, discoverQuery, startShare, openActivity, openDiscover, openShare, accountSection, openLabels, openAlertsManager,
      onSaveConfig, onMenuNavigate,
      onSignedIn, onSignedOut, onUserUpdated, onMenuSignOut,
      themeOptions: THEME_OPTIONS, themePreference, setTheme, themeNow, themeNext, cycleTheme, onSetTickers, onSetPosition, onMovePosition, onSetPortfolios,
      accountStartTab, openAccountPortfolios, leaderboardProfile, openProfile, openSignIn, publicPortfolios, onSetAccountCash, openBankAccounts,
    };
  },
  template: `
    <div id="app">
      <header class="app-header">
        <a class="logo" href="./" aria-label="Oil &amp; Gas Dashboard — home (Markets)" title="Home — Markets"
           :aria-current="activeTab === 'markets' ? 'page' : null" @click.prevent="goHome">
          <img class="logo-icon" src="./favicon.svg" alt="" width="24" height="24" />
          <span class="logo-text" aria-hidden="true">Oil &amp; Gas <span class="logo-accent">Dashboard</span></span>
        </a>
        <nav class="tab-bar">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="tab-btn"
            :class="{ active: activeTab === tab.id }"
            :aria-label="tab.badge ? tab.label + ', ' + tab.badge + ' unread' : (tab.short ? tab.label : null)" :title="tab.short ? tab.label : null"
            @click="selectTab(tab.id)"
          ><span class="label-full">{{ tab.label }}</span><span class="label-short" aria-hidden="true">{{ tab.short ?? tab.label }}</span><span class="count-badge" v-if="tab.badge" aria-hidden="true">{{ tab.badge > 99 ? '99+' : tab.badge }}</span></button>
        </nav>
        <UserMenu
          :user="user"
          :active-tab="activeTab"
          @navigate="onMenuNavigate"
          @sign-out="onMenuSignOut"
        />
      </header>

      <!-- Subheader: My Account + Markets' sections, frozen under the header on every page -->
      <div class="app-subheader">
        <nav class="subtab-bar subtab-bar-fit" ref="subtabBar" aria-label="Sections">
          <button v-for="s in subTabs" :key="s.id" type="button"
                  class="subtab-btn" :class="{ active: subTabActive(s.id), 'subtab-account': s.id === 'my-account' }"
                  :aria-label="s.badge ? s.label + ', ' + s.badge + ' unread in Inbox' : s.label" :title="s.label" :aria-current="subTabActive(s.id) ? 'page' : null"
                  @click="selectSubTab(s.id)"
          ><span class="label-full">{{ s.label }}</span><span class="label-short" aria-hidden="true">{{ s.short }}</span><span class="count-badge" v-if="s.badge" aria-hidden="true">{{ s.badge > 99 ? '99+' : s.badge }}</span></button>
        </nav>
        <div class="subheader-right">
          <div class="text-muted text-sm subheader-updated" v-if="activeTab === 'markets' && marketsUpdated">Updated {{ marketsUpdated }}</div>
          <!-- Theme: one button cycling System → Dark → Light -->
          <button type="button" class="theme-toggle" :disabled="!configLoaded" @click="cycleTheme"
                  :aria-label="'Theme: ' + themeNow.label + ' — switch to ' + themeNext.label" :title="'Theme: ' + themeNow.label + ' (click for ' + themeNext.label + ')'"
          ><span aria-hidden="true">{{ themeNow.icon }}</span></button>
        </div>
      </div>

      <main class="tab-content">
        <!-- Narrow screens: the tabs need the whole row, so Markets' time sits here (not frozen) -->
        <div class="text-muted text-sm subheader-updated-below" v-if="activeTab === 'markets' && marketsUpdated">Updated {{ marketsUpdated }}</div>
        <template v-if="!configLoaded">
          <div class="loading-text">Loading…</div>
        </template>
        <template v-else>
          <div v-if="saveNotice" class="notice" style="margin-bottom:16px">{{ saveNotice }}</div>
          <div v-if="saveError" class="notice error" style="margin-bottom:16px">✗ {{ saveError }}</div>

          <Markets       v-if="activeTab === 'markets'"   :config="config" :user="user"
            v-model:section="marketsSection" @updated-time="marketsUpdated = $event" />
          <Leaderboard   v-if="activeTab === 'leaderboard'" :public-count="publicPortfolios" @make-public="openAccountPortfolios"
            :signed-in="!!user" v-model:profile="leaderboardProfile" @sign-in="openSignIn"
            :refresh-seconds="config.ui?.refreshIntervalSeconds ?? 60" />
          <Stocks        v-if="activeTab === 'portfolio'" :config="config" :user="user" portfolio-only :start-tab="accountStartTab"
            :discover-query="discoverQuery" :start-share="startShare" @go-activity="openActivity" @set-tickers="onSetTickers"
            @set-position="onSetPosition" @move-position="onMovePosition" @set-portfolios="onSetPortfolios" @set-account-cash="onSetAccountCash"
            @go-bank-accounts="openBankAccounts" @go-notes="openNotes" />
          <Inbox         v-if="activeTab === 'inbox'"     :config="config" v-model:section="inboxSection" @manage-labels="openLabels" @manage-alerts="openAlertsManager"
            :focus-post="focusPost" @discover="openDiscover()" @share="openShare" @clear-focus="focusPost = null" />

          <Account v-if="activeTab === 'account'" :user="user" :config="config" v-model:section="accountSection" @save-settings="onSaveConfig"
            @signed-in="onSignedIn"
            @signed-out="onSignedOut"
            @updated="onUserUpdated"
          />
        </template>
      </main>

      <footer class="app-footer">
        <span>© {{ new Date().getFullYear() }} Oil &amp; Gas Dashboard</span>
        <span>Data: EIA · FRED · Yahoo Finance · SEC EDGAR · RSS feeds. Market data may be delayed; not investment advice.</span>
      </footer>

      <ArticleViewer />
    </div>
  `,
};

createApp(App).mount('#app');
